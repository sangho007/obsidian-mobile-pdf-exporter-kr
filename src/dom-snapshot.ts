import {
  canvasToPngBlob,
  getSafeRasterDimensions,
  hasPngSignature,
  readResponseBlobWithinLimit
} from "./media-raster";
import { segmentTextGraphemes } from "./text-layout";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SNAPSHOT_ATTRIBUTE = "data-mobile-pdf-snapshot-id";
const SNAPSHOT_STYLE_ATTRIBUTE = "data-mobile-pdf-style-id";
const SNAPSHOT_TIMEOUT_MS = 6_000;
const FONT_WAIT_TIMEOUT_MS = 2_500;
const SNAPSHOT_PREPARE_TIMEOUT_MS = 10_000;
const RESOURCE_FETCH_TIMEOUT_MS = 1_800;
const MAX_SNAPSHOT_ELEMENTS = 4_000;
const MAX_SNAPSHOT_CONTENT_NODES = 20_000;
const MAX_SNAPSHOT_MARKUP_CHARS = 8_000_000;
const MAX_SERIALIZED_STYLE_CHARS = 64 * 1024;
const MAX_SNAPSHOT_CANVAS_DIMENSION = 4_096;
const MAX_SNAPSHOT_CANVAS_PIXELS = 12_000_000;
const MAX_SNAPSHOT_PNG_BYTES = 32 * 1024 * 1024;
const MAX_INLINE_MEDIA_DIMENSION = 2_048;
const MAX_INLINE_MEDIA_PIXELS = 2_000_000;
const MAX_INLINE_RESOURCE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_INLINE_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_RESOURCE_COUNT = 24;
const MAX_INLINE_MEDIA_BYTES = MAX_INLINE_RESOURCE_BYTES;
const MAX_TOTAL_INLINE_MEDIA_BYTES = MAX_TOTAL_INLINE_RESOURCE_BYTES;
const MAX_INLINE_MEDIA_DATA_URL_CHARS = Math.ceil(MAX_INLINE_MEDIA_BYTES * 4 / 3) + 64;
const MAX_TOTAL_INLINE_MEDIA_DATA_URL_CHARS = 7 * 1024 * 1024;
const MAX_INLINE_MEDIA_COUNT = MAX_INLINE_RESOURCE_COUNT;

export interface DomSnapshotPrepareOptions {
  sourceWidthPx: number;
  backgroundCss: string;
}

export interface DomSnapshotPageOptions {
  pageTopPx: number;
  pageHeightPx: number;
  scale: number;
  grayscale: boolean;
}

export interface PreparedDomSnapshot {
  renderPage(options: DomSnapshotPageOptions): Promise<Uint8Array>;
}

interface StyledCloneResult {
  markup: string;
  pseudoCss: string;
}

interface ScrolledClonePair {
  original: HTMLElement;
  target: HTMLElement;
  scrollLeft: number;
  scrollTop: number;
}

interface CssUrlCache {
  values: Map<string, Promise<string | null>>;
  totalBytes: number;
  fetchQueue: Promise<void>;
  signal: AbortSignal;
  unresolved: Set<string>;
}

interface InlineMediaBudget {
  count: number;
  totalBytes: number;
  totalDataUrlChars: number;
}

interface SnapshotMemoryBudget {
  retainedChars: number;
}

/**
 * Freezes the browser-rendered DOM into an XHTML snapshot once, then lets
 * callers rasterize bounded page slices. Unlike the legacy fallback renderer,
 * the browser itself paints tables, inline backgrounds, decorations, pseudo
 * elements, transforms and font metrics.
 */
export async function prepareDomSnapshot(
  source: HTMLElement,
  options: DomSnapshotPrepareOptions
): Promise<PreparedDomSnapshot> {
  const ownerDocument = source.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("DOM snapshot requires an attached document.");

  const sourceWidthPx = finitePositive(options.sourceWidthPx, "source width");
  await waitForDocumentFonts(ownerDocument, FONT_WAIT_TIMEOUT_MS);
  const preparationController = new AbortController();
  const frozen = await withTimeout(
    createStyledClone(source, preparationController.signal),
    SNAPSHOT_PREPARE_TIMEOUT_MS,
    "DOM snapshot preparation timed out.",
    () => preparationController.abort()
  );
  let terminalRenderError: unknown = null;

  return {
    async renderPage(pageOptions: DomSnapshotPageOptions): Promise<Uint8Array> {
      if (terminalRenderError) throw terminalRenderError;
      const pageTopPx = finiteNonNegative(pageOptions.pageTopPx, "page top");
      const pageHeightPx = finitePositive(pageOptions.pageHeightPx, "page height");
      const scale = clamp(pageOptions.scale, 0.25, 3);
      const svgMarkup = buildPageSvg({
        sourceMarkup: frozen.markup,
        pseudoCss: frozen.pseudoCss,
        sourceWidthPx,
        pageTopPx,
        pageHeightPx,
        backgroundCss: options.backgroundCss
      });

      try {
        return await rasterizeSvgPage(ownerDocument, svgMarkup, {
          widthPx: sourceWidthPx,
          heightPx: pageHeightPx,
          scale,
          backgroundCss: options.backgroundCss,
          grayscale: pageOptions.grayscale
        });
      } catch (error) {
        terminalRenderError = error;
        throw error;
      }
    }
  };
}

async function createStyledClone(source: HTMLElement, signal: AbortSignal): Promise<StyledCloneResult> {
  const ownerDocument = source.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("DOM snapshot requires a window.");

  const sourceElements: Element[] = [source, ...Array.from(source.querySelectorAll("*"))];
  if (sourceElements.length > MAX_SNAPSHOT_ELEMENTS) {
    throw new Error(`DOM snapshot contains too many elements (${sourceElements.length}).`);
  }
  assertSourceDomWithinBudget(source, sourceElements);
  const clone = source.cloneNode(true) as HTMLElement;
  removeSnapshotComments(clone);
  const cloneElements: Element[] = [clone, ...Array.from(clone.querySelectorAll("*"))];
  if (sourceElements.length !== cloneElements.length) {
    throw new Error("DOM changed while preparing the PDF snapshot.");
  }

  const pseudoRules: string[] = [];
  const styleRules: string[] = [];
  const styleIds = new Map<string, string>();
  const usedFontFamilies = new Set<string>();
  const memoryBudget: SnapshotMemoryBudget = { retainedChars: 0 };
  const cssUrlCache: CssUrlCache = {
    values: new Map(),
    totalBytes: 0,
    fetchQueue: Promise.resolve(),
    signal,
    unresolved: new Set()
  };
  const pendingCssUrls: Promise<void>[] = [];
  const mediaPairs: Array<{ original: Element; target: Element }> = [];
  const scrolledPairs: ScrolledClonePair[] = [];
  const cloneBySource = new Map<Element, Element>();

  for (let index = 0; index < sourceElements.length; index += 1) {
    if (index % 64 === 0) {
      ensureNotAborted(signal);
      await yieldToEventLoop(ownerWindow);
    }
    const original = sourceElements[index];
    const target = cloneElements[index];
    cloneBySource.set(original, target);
    const snapshotId = `s${index}`;
    target.setAttribute(SNAPSHOT_ATTRIBUTE, snapshotId);
    stripExecutableAttributes(target);

    const computed = ownerWindow.getComputedStyle(original);
    for (const family of parseFontFamilies(computed.fontFamily)) usedFontFamilies.add(family);
    pendingCssUrls.push(
      serializeComputedStyle(computed, ownerDocument, cssUrlCache, original).then((serialized) => {
        const frozenStyle = `${serialized}animation:none !important;transition:none !important;caret-color:transparent !important;`;
        let styleId = styleIds.get(frozenStyle);
        if (!styleId) {
          styleId = `c${styleIds.size}`;
          const rule = `[${SNAPSHOT_STYLE_ATTRIBUTE}="${styleId}"]{${frozenStyle}}`;
          reserveSnapshotChars(memoryBudget, frozenStyle.length + rule.length);
          styleIds.set(frozenStyle, styleId);
          styleRules.push(rule);
        }
        target.removeAttribute("style");
        target.setAttribute(SNAPSHOT_STYLE_ATTRIBUTE, styleId);
      })
    );

    const pseudoElements: Array<"::before" | "::after" | "::marker" | "::first-letter" | "::first-line"> = ["::before", "::after"];
    if (original.tagName.toLowerCase() === "li") pseudoElements.push("::marker");
    if (isFirstLetterCandidate(original, computed)) pseudoElements.push("::first-letter", "::first-line");
    pendingCssUrls.push((async () => {
      const firstLetterStyle = ownerWindow.getComputedStyle(original, "::first-letter");
      const firstLineStyle = ownerWindow.getComputedStyle(original, "::first-line");
      const preserveFirstLine = isFirstLetterCandidate(original, computed) &&
        shouldPreservePseudoElement(original, "::first-line", firstLineStyle, computed);
      const preserveFirstLetter = isFirstLetterCandidate(original, computed) &&
        shouldPreservePseudoElement(original, "::first-letter", firstLetterStyle, computed) &&
        hasIndependentFirstLetterStyle(firstLetterStyle, firstLineStyle);
      let materializedBefore = false;
      for (const pseudo of pseudoElements) {
        const pseudoStyle = pseudo === "::first-letter"
          ? firstLetterStyle
          : pseudo === "::first-line"
            ? firstLineStyle
          : ownerWindow.getComputedStyle(original, pseudo);
        if (pseudo === "::first-letter" && !preserveFirstLetter) continue;
        if (pseudo === "::first-line" && !preserveFirstLine) continue;
        if (!shouldPreservePseudoElement(original, pseudo, pseudoStyle, computed)) continue;
        for (const family of parseFontFamilies(pseudoStyle.fontFamily)) usedFontFamilies.add(family);
        const css = await serializeComputedStyle(pseudoStyle, ownerDocument, cssUrlCache);
        if (!css) continue;
        const frozenPseudoStyle = `${css}${getPseudoCurrentColorOverrides(pseudoStyle, computed)}`;
        if (pseudo === "::before" && preserveFirstLetter) {
          const generatedText = parseSimpleGeneratedContent(pseudoStyle.content);
          if (generatedText !== null) {
            reserveSnapshotChars(memoryBudget, frozenPseudoStyle.length + generatedText.length);
            materializeGeneratedBefore(target, generatedText, frozenPseudoStyle);
            materializedBefore = true;
            continue;
          }
        }
        if (pseudo === "::first-letter" &&
            (materializedBefore || !hasGeneratedBeforeText(original, ownerWindow)) &&
            materializeFirstLetter(original, target, frozenPseudoStyle, ownerWindow)) {
          reserveSnapshotChars(memoryBudget, frozenPseudoStyle.length);
          continue;
        }
        if (pseudo === "::first-line" &&
            !preserveFirstLetter &&
            !hasGeneratedBeforeText(original, ownerWindow) &&
            materializeFirstLine(original, target, frozenPseudoStyle, ownerWindow)) {
          reserveSnapshotChars(memoryBudget, frozenPseudoStyle.length);
          continue;
        }
        const selector = `[${SNAPSHOT_ATTRIBUTE}="${snapshotId}"]${pseudo}`;
        const rule = `${selector}{${frozenPseudoStyle}}`;
        reserveSnapshotChars(memoryBudget, rule.length);
        pseudoRules.push(rule);
      }
    })());

    preserveLiveElementState(original, target);
    if (original instanceof HTMLElement && target instanceof HTMLElement &&
        canFreezeScrollState(original) &&
        (Math.abs(original.scrollTop) > 0.1 || Math.abs(original.scrollLeft) > 0.1)) {
      scrolledPairs.push({
        original,
        target,
        scrollLeft: original.scrollLeft,
        scrollTop: original.scrollTop
      });
    }
    mediaPairs.push({ original, target });
  }

  await Promise.all(pendingCssUrls);
  ensureNotAborted(signal);
  const unresolvedMedia: string[] = [];
  const mediaBudget = createInlineMediaBudget();
  for (const [index, pair] of mediaPairs.entries()) {
    if (index % 64 === 0) {
      ensureNotAborted(signal);
      await yieldToEventLoop(ownerWindow);
    }
    const unresolved = await inlineMediaElement(pair.original, pair.target, mediaBudget, signal);
    if (unresolved) {
      unresolvedMedia.push(unresolved);
      break;
    }
  }
  if (unresolvedMedia.length > 0) {
    throw new Error(`DOM snapshot could not inline ${unresolvedMedia.length} media resource(s).`);
  }
  const fontFaceCss = await collectUsedFontFaceCss(
    ownerDocument,
    usedFontFamilies,
    cssUrlCache,
    memoryBudget
  );
  ensureNotAborted(signal);
  if (cssUrlCache.unresolved.size > 0) {
    throw new Error(`DOM snapshot could not inline ${cssUrlCache.unresolved.size} visual resource(s).`);
  }
  unresolvedMedia.push(...findExternalSvgResources(clone));
  if (unresolvedMedia.length > 0) {
    throw new Error(`DOM snapshot could not inline ${unresolvedMedia.length} media resource(s).`);
  }
  freezeScrolledElementStates(scrolledPairs, cloneBySource, ownerWindow);
  removeUnsafeSnapshotNodes(clone);
  clone.setAttribute("xmlns", XHTML_NAMESPACE);

  const Serializer = ownerWindow.XMLSerializer;
  const serializer = new Serializer();
  const markup = serializer.serializeToString(clone);
  const pseudoCss = [fontFaceCss, ...styleRules, ...pseudoRules].filter(Boolean).join("\n");
  if (markup.length + pseudoCss.length > MAX_SNAPSHOT_MARKUP_CHARS) {
    throw new Error("DOM snapshot exceeds the safe mobile memory budget.");
  }
  return {
    markup,
    pseudoCss
  };
}

function assertSourceDomWithinBudget(
  source: HTMLElement,
  elements: Element[]
): void {
  let sourceChars = elements.length * 32;
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      sourceChars += attribute.name.length + attribute.value.length + 4;
      if (sourceChars > MAX_SNAPSHOT_MARKUP_CHARS) {
        throw new Error("DOM snapshot source exceeds the safe mobile memory budget.");
      }
    }
  }

  const walker = source.ownerDocument.createTreeWalker(
    source,
    4 | 128 /* NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT */
  );
  let contentNodeCount = 0;
  while (walker.nextNode()) {
    contentNodeCount += 1;
    if (contentNodeCount > MAX_SNAPSHOT_CONTENT_NODES) {
      throw new Error(`DOM snapshot contains too many text/comment nodes (${contentNodeCount}).`);
    }
    sourceChars += (walker.currentNode.nodeValue ?? "").length;
    if (sourceChars > MAX_SNAPSHOT_MARKUP_CHARS) {
      throw new Error("DOM snapshot source exceeds the safe mobile memory budget.");
    }
  }
}

function reserveSnapshotChars(memoryBudget: SnapshotMemoryBudget, chars: number): void {
  if (!Number.isSafeInteger(chars) || chars < 0 ||
      memoryBudget.retainedChars + chars > MAX_SNAPSHOT_MARKUP_CHARS) {
    throw new Error("DOM snapshot styles exceed the safe mobile memory budget.");
  }
  memoryBudget.retainedChars += chars;
}

function removeSnapshotComments(root: HTMLElement): void {
  const walker = root.ownerDocument.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
}

function parseFontFamilies(fontFamily: string): string[] {
  return fontFamily
    .split(",")
    .map((family) => family.trim().replace(/^['"]|['"]$/gu, "").toLowerCase())
    .filter(Boolean);
}

async function collectUsedFontFaceCss(
  ownerDocument: Document,
  usedFontFamilies: Set<string>,
  cache: CssUrlCache,
  memoryBudget: SnapshotMemoryBudget
): Promise<string> {
  const fontRules: string[] = [];
  const visitRules = async (rules: CSSRuleList): Promise<void> => {
    for (const rule of Array.from(rules)) {
      ensureNotAborted(cache.signal);
      if (rule.type === 5) {
        const fontRule = rule as CSSFontFaceRule;
        const family = fontRule.style.getPropertyValue("font-family")
          .trim()
          .replace(/^['"]|['"]$/gu, "")
          .toLowerCase();
        if (!family || !usedFontFamilies.has(family)) continue;
        const serializedRule = await inlineCssUrls(
          fontRule.cssText,
          ownerDocument,
          cache,
          fontRule.parentStyleSheet?.href ?? ownerDocument.baseURI
        );
        reserveSnapshotChars(memoryBudget, serializedRule.length);
        fontRules.push(serializedRule);
        continue;
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) await visitRules(nested);
    }
  };

  for (const sheet of Array.from(ownerDocument.styleSheets)) {
    ensureNotAborted(cache.signal);
    try {
      if (sheet.cssRules) await visitRules(sheet.cssRules);
    } catch {
      // Cross-origin style sheets cannot be inspected. Their already-loaded
      // system fallback remains available; unresolved captures use the legacy
      // compatibility renderer.
    }
  }
  return fontRules.join("\n");
}

async function serializeComputedStyle(
  style: CSSStyleDeclaration,
  ownerDocument: Document,
  cache: CssUrlCache,
  sourceElement?: Element
): Promise<string> {
  const declarations: string[] = [];
  let serializedChars = 0;
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index);
    // Standard computed longhands already contain resolved var() values.
    // Repeating inherited, potentially multi-megabyte custom properties for
    // every descendant provides no paint fidelity and can exhaust an iOS heap.
    if (!property || property.startsWith("--")) continue;
    const authoredGeometry = sourceElement
      ? getAuthoredTableInlineGeometry(sourceElement, property)
      : null;
    if (sourceElement && shouldSkipFrozenTableGeometry(sourceElement, property) && !authoredGeometry) continue;
    const rawValue = authoredGeometry?.value ??
      (property === "cursor" ? "auto" : style.getPropertyValue(property));
    if (!rawValue) continue;
    const value = rawValue.includes("url(")
      ? await inlineCssUrls(rawValue, ownerDocument, cache)
      : rawValue;
    const priority = (authoredGeometry?.priority ?? style.getPropertyPriority(property)) ? " !important" : "";
    const declaration = `${property}:${value}${priority};`;
    serializedChars += declaration.length;
    if (serializedChars > MAX_SERIALIZED_STYLE_CHARS) {
      throw new Error("A computed style exceeds the safe mobile memory budget.");
    }
    declarations.push(declaration);
  }
  return declarations.join("");
}

const TABLE_INTERNAL_TAGS = new Set(["caption", "col", "colgroup", "thead", "tbody", "tfoot", "tr", "th", "td"]);
const TABLE_INTRINSIC_GEOMETRY_PROPERTIES = new Set([
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "inline-size", "block-size", "min-inline-size", "max-inline-size", "min-block-size", "max-block-size"
]);
const TABLE_BLOCK_GEOMETRY_PROPERTIES = new Set([
  "height", "min-height", "max-height", "block-size", "min-block-size", "max-block-size"
]);

function shouldSkipFrozenTableGeometry(element: Element, property: string): boolean {
  const tag = element.tagName.toLowerCase();
  return (TABLE_INTERNAL_TAGS.has(tag) && TABLE_INTRINSIC_GEOMETRY_PROPERTIES.has(property)) ||
    (tag === "table" && TABLE_BLOCK_GEOMETRY_PROPERTIES.has(property));
}

function getAuthoredTableInlineGeometry(
  element: Element,
  property: string
): { value: string; priority: string } | null {
  const tag = element.tagName.toLowerCase();
  if (!["col", "colgroup", "th", "td"].includes(tag) || !["width", "inline-size"].includes(property)) {
    return null;
  }
  const inlineStyle = (element as HTMLElement).style;
  const inlineValue = inlineStyle?.getPropertyValue(property).trim();
  if (inlineValue) {
    return { value: inlineValue, priority: inlineStyle.getPropertyPriority(property) };
  }
  if (property !== "width") return null;
  const widthAttribute = element.getAttribute("width")?.trim();
  if (!widthAttribute) return null;
  return {
    value: /^\d+(?:\.\d+)?$/u.test(widthAttribute) ? `${widthAttribute}px` : widthAttribute,
    priority: ""
  };
}

function shouldPreservePseudoElement(
  original: Element,
  pseudo: "::before" | "::after" | "::marker" | "::first-letter" | "::first-line",
  pseudoStyle: CSSStyleDeclaration,
  elementStyle: CSSStyleDeclaration
): boolean {
  if (pseudo === "::marker") {
    return original.tagName.toLowerCase() === "li" && elementStyle.display === "list-item";
  }
  if (pseudo === "::first-letter") {
    if (FIRST_LETTER_INHERITED_PROPERTIES.some((property) =>
      pseudoStyle.getPropertyValue(property) !== elementStyle.getPropertyValue(property)
    )) return true;
    if (pseudoStyle.float !== "none" || pseudoStyle.verticalAlign !== "baseline") return true;
    if (pseudoStyle.backgroundColor !== "rgba(0, 0, 0, 0)" || pseudoStyle.backgroundImage !== "none") return true;
    return ["margin", "padding"].some((prefix) => ["top", "right", "bottom", "left"].some((side) =>
      isNonZeroCssLength(pseudoStyle.getPropertyValue(`${prefix}-${side}`))
    )) || ["top", "right", "bottom", "left"].some((side) =>
      isNonZeroCssLength(pseudoStyle.getPropertyValue(`border-${side}-width`))
    );
  }
  if (pseudo === "::first-line") {
    return FIRST_LINE_INHERITED_PROPERTIES.some((property) =>
      pseudoStyle.getPropertyValue(property) !== elementStyle.getPropertyValue(property)
    ) || pseudoStyle.backgroundColor !== "rgba(0, 0, 0, 0)" || pseudoStyle.backgroundImage !== "none";
  }
  const content = pseudoStyle.content.trim();
  if (content && content !== "none" && content !== "normal") return true;
  if (pseudoStyle.backgroundImage !== "none") return true;
  const maskImage = pseudoStyle.getPropertyValue("mask-image") || pseudoStyle.getPropertyValue("-webkit-mask-image");
  return Boolean(maskImage && maskImage !== "none");
}

const FIRST_LETTER_INHERITED_PROPERTIES = [
  "color", "font-family", "font-size", "font-style", "font-weight",
  "letter-spacing", "line-height", "text-decoration", "text-shadow", "text-transform"
];
const FIRST_LINE_INHERITED_PROPERTIES = [
  "color", "font-family", "font-size", "font-style", "font-weight",
  "letter-spacing", "line-height", "text-decoration", "text-shadow", "text-transform",
  "vertical-align"
];

const FIRST_LETTER_INDEPENDENT_PROPERTIES = [
  ...FIRST_LETTER_INHERITED_PROPERTIES,
  "float", "vertical-align", "background-color", "background-image",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"
];

function hasIndependentFirstLetterStyle(
  firstLetterStyle: CSSStyleDeclaration,
  firstLineStyle: CSSStyleDeclaration
): boolean {
  return FIRST_LETTER_INDEPENDENT_PROPERTIES.some((property) =>
    firstLetterStyle.getPropertyValue(property) !== firstLineStyle.getPropertyValue(property)
  );
}

function isNonZeroCssLength(value: string): boolean {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && Math.abs(number) > 0.001;
}

function isFirstLetterCandidate(element: Element, style: CSSStyleDeclaration): boolean {
  if (!element.textContent?.trim()) return false;
  return ["block", "flow-root", "list-item", "table-cell", "inline-block"].includes(style.display);
}

function getPseudoCurrentColorOverrides(
  pseudoStyle: CSSStyleDeclaration,
  elementStyle: CSSStyleDeclaration
): string {
  if (pseudoStyle.color === elementStyle.color) return "";
  const overrides: string[] = [];
  for (const property of ["-webkit-text-fill-color", "-webkit-text-stroke-color"]) {
    const pseudoValue = pseudoStyle.getPropertyValue(property);
    if (pseudoValue &&
        (pseudoValue === elementStyle.getPropertyValue(property) || pseudoValue === pseudoStyle.color)) {
      // Some foreignObject rasterizers resolve currentColor against the
      // originating element (or a generated ::before box) instead of the
      // first-letter/first-line pseudo. Freeze the already-computed pseudo
      // color rather than leaving another currentColor dependency.
      overrides.push(`${property}:${pseudoStyle.color}!important;`);
    }
  }
  const pseudoFill = pseudoStyle.getPropertyValue("fill");
  if (pseudoFill && pseudoFill === elementStyle.getPropertyValue("fill")) {
    // SVG foreignObject rasterizers can resolve currentColor for `fill`
    // against the parent element instead of the pseudo element. Freeze the
    // pseudo's resolved text color explicitly to avoid black first-line/
    // first-letter glyphs.
    overrides.push(`fill:${pseudoStyle.color}!important;`);
  }
  return overrides.join("");
}

function parseSimpleGeneratedContent(content: string): string | null {
  const value = content.trim();
  if (value.length < 2) return null;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return null;
  return value.slice(1, -1).replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/gu, (_match, hex, escaped) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return escaped ?? "";
  });
}

function materializeGeneratedBefore(target: Element, text: string, frozenStyle: string): void {
  const span = target.ownerDocument.createElement("span");
  span.setAttribute("data-mobile-pdf-materialized-pseudo", "before");
  span.setAttribute("style", frozenStyle);
  span.textContent = text;
  target.insertBefore(span, target.firstChild);
}

function materializeFirstLetter(
  original: Element,
  target: Element,
  frozenStyle: string,
  ownerWindow: Window
): boolean {
  if (hasNestedFirstLetterCandidate(original, ownerWindow)) return false;
  const range = findFirstLetterTextRange(original, target, ownerWindow);
  // Avoid cloning/splitting nested inline element trees: asynchronous style
  // plans still hold references to those cloned descendants. Native pseudo
  // CSS remains the compatibility path for cross-node first-letter text.
  if (!range || range.startContainer !== range.endContainer) return false;
  const ownerDocument = target.ownerDocument;
  const contents = range.extractContents();
  const span = ownerDocument.createElement("span");
  span.setAttribute("data-mobile-pdf-materialized-pseudo", "first-letter");
  span.setAttribute("style", frozenStyle);
  span.appendChild(contents);
  range.insertNode(span);
  return true;
}

function hasNestedFirstLetterCandidate(original: Element, ownerWindow: Window): boolean {
  const showText = original.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = original.ownerDocument.createTreeWalker(original, showText);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if ((textNode.nodeValue ?? "").trim() && isEligibleFirstLetterTextNode(textNode, original, ownerWindow)) {
      let element = textNode.parentElement;
      while (element && element !== original) {
        if (isFirstLetterCandidate(element, ownerWindow.getComputedStyle(element))) return true;
        element = element.parentElement;
      }
      return false;
    }
    node = walker.nextNode();
  }
  return false;
}

function materializeFirstLine(
  original: Element,
  target: Element,
  frozenStyle: string,
  ownerWindow: Window
): boolean {
  const range = findFirstLineTextRange(original, target, ownerWindow);
  // A cross-node extractContents() would clone partial inline ancestors and
  // invalidate the source/clone element references still being styled.
  if (!range || range.startContainer !== range.endContainer) return false;
  const contents = range.extractContents();
  const span = target.ownerDocument.createElement("span");
  span.setAttribute("data-mobile-pdf-materialized-pseudo", "first-line");
  span.setAttribute("style", frozenStyle);
  span.appendChild(contents);
  range.insertNode(span);
  return true;
}

interface FirstLineGraphemePair {
  sourceNode: Text;
  sourceStart: number;
  sourceEnd: number;
  targetNode: Text;
  targetStart: number;
  targetEnd: number;
}

function findFirstLineTextRange(original: Element, target: Element, ownerWindow: Window): Range | null {
  const ownerDocument = target.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const sourceWalker = ownerDocument.createTreeWalker(original, showText);
  const targetWalker = ownerDocument.createTreeWalker(target, showText);
  const pairs: FirstLineGraphemePair[] = [];
  let sourceNode = sourceWalker.nextNode();
  let targetNode = targetWalker.nextNode();
  while (sourceNode && targetNode && pairs.length < 512) {
    const sourceText = sourceNode as Text;
    const targetText = targetNode as Text;
    if (isEligibleFirstLetterTextNode(sourceText, original, ownerWindow)) {
      const sourceSegments = segmentTextGraphemes(sourceText.nodeValue ?? "");
      const targetSegments = segmentTextGraphemes(targetText.nodeValue ?? "");
      if (sourceSegments.length !== targetSegments.length) return null;
      for (let index = 0; index < sourceSegments.length && pairs.length < 512; index += 1) {
        const sourceSegment = sourceSegments[index];
        const targetSegment = targetSegments[index];
        pairs.push({
          sourceNode: sourceText,
          sourceStart: sourceSegment.start,
          sourceEnd: sourceSegment.end,
          targetNode: targetText,
          targetStart: targetSegment.start,
          targetEnd: targetSegment.end
        });
      }
    }
    sourceNode = sourceWalker.nextNode();
    targetNode = targetWalker.nextNode();
  }

  let firstIndex = -1;
  let lastIndex = -1;
  let firstLineTop = 0;
  let lineTolerance = 1;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const sourceRange = ownerDocument.createRange();
    sourceRange.setStart(pair.sourceNode, pair.sourceStart);
    sourceRange.setEnd(pair.sourceNode, pair.sourceEnd);
    const rect = sourceRange.getBoundingClientRect();
    if (rect.width < 0.1 || rect.height < 0.1) continue;
    if (firstIndex < 0) {
      firstIndex = index;
      lastIndex = index;
      firstLineTop = rect.top;
      lineTolerance = Math.max(1, rect.height * 0.45);
      continue;
    }
    if (Math.abs(rect.top - firstLineTop) > lineTolerance) break;
    lastIndex = index;
  }
  if (firstIndex < 0 || lastIndex < firstIndex) return null;
  const first = pairs[firstIndex];
  const last = pairs[lastIndex];
  const range = ownerDocument.createRange();
  range.setStart(first.targetNode, first.targetStart);
  range.setEnd(last.targetNode, last.targetEnd);
  return range;
}

interface FirstLetterGrapheme {
  node: Text;
  start: number;
  end: number;
  text: string;
}

function findFirstLetterTextRange(original: Element, target: Element, ownerWindow: Window): Range | null {
  const ownerDocument = target.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  // A descendant may have materialized its own ::before while pseudo plans
  // are running asynchronously. Only the span inserted directly for this
  // element can contribute this element's first letter.
  const materializedBefore = Array.from(target.children).find((child) =>
    child.getAttribute("data-mobile-pdf-materialized-pseudo") === "before"
  ) ?? null;
  if (materializedBefore) {
    const beforeWalker = ownerDocument.createTreeWalker(materializedBefore, showText);
    const beforeGraphemes: FirstLetterGrapheme[] = [];
    let beforeNode = beforeWalker.nextNode();
    while (beforeNode && beforeGraphemes.length < 256) {
      const textNode = beforeNode as Text;
      for (const segment of segmentTextGraphemes(textNode.nodeValue ?? "")) {
        beforeGraphemes.push({ node: textNode, start: segment.start, end: segment.end, text: segment.text });
      }
      beforeNode = beforeWalker.nextNode();
    }
    return buildFirstLetterRange(beforeGraphemes, ownerDocument);
  }
  const sourceWalker = ownerDocument.createTreeWalker(original, showText);
  const targetWalker = ownerDocument.createTreeWalker(target, showText);
  const graphemes: FirstLetterGrapheme[] = [];
  let started = false;
  let sourceNode = sourceWalker.nextNode();
  let targetNode = targetWalker.nextNode();
  while (sourceNode && targetNode && graphemes.length < 256) {
    const sourceTextNode = sourceNode as Text;
    const textNode = targetNode as Text;
    if (!isEligibleFirstLetterTextNode(sourceTextNode, original, ownerWindow)) {
      sourceNode = sourceWalker.nextNode();
      targetNode = targetWalker.nextNode();
      continue;
    }
    const value = textNode.nodeValue ?? "";
    for (const segment of segmentTextGraphemes(value)) {
      if (!started && /^\s+$/u.test(segment.text)) continue;
      started = true;
      graphemes.push({
        node: textNode,
        start: segment.start,
        end: segment.end,
        text: segment.text
      });
      if (graphemes.length >= 256) break;
    }
    sourceNode = sourceWalker.nextNode();
    targetNode = targetWalker.nextNode();
  }
  return buildFirstLetterRange(graphemes, ownerDocument);
}

function buildFirstLetterRange(graphemes: FirstLetterGrapheme[], ownerDocument: Document): Range | null {
  if (!graphemes.length) return null;

  let letterIndex = -1;
  for (let index = 0; index < graphemes.length; index += 1) {
    const text = graphemes[index].text;
    if (isFirstLetterTypographicUnit(text)) {
      letterIndex = index;
      break;
    }
    if (isPunctuationGrapheme(text) || isFirstLetterInterveningSpace(text) || isMarkGrapheme(text)) continue;
    break;
  }
  // Retain compatibility for unusual scripts/control sequences the browser's
  // grapheme segmenter exposes without a leading L/N/S code point.
  if (letterIndex < 0) letterIndex = 0;

  let lastIncludedIndex = letterIndex;
  for (let index = letterIndex + 1; index < graphemes.length; index += 1) {
    const text = graphemes[index].text;
    if (isFirstLetterSuffixPunctuation(text)) {
      lastIncludedIndex = index;
      continue;
    }
    if (isFirstLetterInterveningSpace(text)) continue;
    break;
  }

  const first = graphemes[0];
  const last = graphemes[lastIncludedIndex];
  const range = ownerDocument.createRange();
  range.setStart(first.node, first.start);
  range.setEnd(last.node, last.end);
  return range;
}

function isEligibleFirstLetterTextNode(node: Text, boundary: Element, ownerWindow: Window): boolean {
  let element = node.parentElement;
  while (element) {
    if (element.hidden) return false;
    const style = ownerWindow.getComputedStyle(element);
    if (style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.getPropertyValue("content-visibility") === "hidden") return false;
    if (element === boundary) break;
    element = element.parentElement;
  }
  return true;
}

function hasGeneratedBeforeText(element: Element, ownerWindow: Window): boolean {
  const content = ownerWindow.getComputedStyle(element, "::before").content.trim();
  return Boolean(content && content !== "none" && content !== "normal" && content !== '""' && content !== "''");
}

function isFirstLetterTypographicUnit(text: string): boolean {
  return /[\p{Letter}\p{Number}\p{Symbol}]/u.test(text);
}

function isPunctuationGrapheme(text: string): boolean {
  const first = Array.from(text)[0] ?? "";
  return /^\p{Punctuation}$/u.test(first);
}

function isFirstLetterSuffixPunctuation(text: string): boolean {
  const first = Array.from(text)[0] ?? "";
  return /^\p{Punctuation}$/u.test(first) &&
    !/^\p{Open_Punctuation}$/u.test(first) &&
    !/^\p{Dash_Punctuation}$/u.test(first);
}

function isFirstLetterInterveningSpace(text: string): boolean {
  return text !== "\u3000" && /^\p{Space_Separator}+$/u.test(text);
}

function isMarkGrapheme(text: string): boolean {
  return /^\p{Mark}+$/u.test(text);
}

function preserveLiveElementState(original: Element, target: Element): void {
  const tag = original.tagName.toLowerCase();
  if (tag === "input") {
    const sourceInput = original as HTMLInputElement;
    const targetInput = target as HTMLInputElement;
    targetInput.checked = sourceInput.checked;
    targetInput.value = sourceInput.value;
    if (sourceInput.checked) targetInput.setAttribute("checked", "");
    else targetInput.removeAttribute("checked");
    targetInput.setAttribute("value", sourceInput.value);
    return;
  }
  if (tag === "textarea") {
    const value = (original as HTMLTextAreaElement).value;
    (target as HTMLTextAreaElement).value = value;
    target.textContent = value;
    return;
  }
  if (tag === "select") {
    const sourceOptions = Array.from((original as HTMLSelectElement).options);
    const targetOptions = Array.from((target as HTMLSelectElement).options);
    for (let index = 0; index < sourceOptions.length; index += 1) {
      if (!targetOptions[index]) continue;
      targetOptions[index].selected = sourceOptions[index].selected;
      if (sourceOptions[index].selected) targetOptions[index].setAttribute("selected", "");
      else targetOptions[index].removeAttribute("selected");
    }
    return;
  }
  if (tag === "details") {
    (target as HTMLDetailsElement).open = (original as HTMLDetailsElement).open;
  }
}

function canFreezeScrollState(element: HTMLElement): boolean {
  return !["canvas", "img", "input", "select", "textarea", "video", "audio", "table", "thead", "tbody", "tfoot", "tr"]
    .includes(element.tagName.toLowerCase());
}

function freezeScrolledElementStates(
  pairs: ScrolledClonePair[],
  cloneBySource: Map<Element, Element>,
  ownerWindow: Window
): void {
  if (!pairs.length) return;
  const scrolledSources = new Set<Element>(pairs.map((pair) => pair.original));

  // Inner scrollports are frozen first so an outer sticky overlay includes
  // their already-frozen visual state.
  for (const pair of [...pairs].reverse()) {
    const { original, target, scrollLeft, scrollTop } = pair;
    const ownerDocument = target.ownerDocument;
    const computed = ownerWindow.getComputedStyle(original);
    const wrapper = ownerDocument.createElement("div");
    wrapper.setAttribute("data-mobile-pdf-scroll-content", "");
    const layoutStyle = getScrollWrapperLayoutStyle(computed);
    wrapper.setAttribute(
      "style",
      `position:relative!important;left:0!important;top:0!important;` +
      `width:${Math.max(original.scrollWidth, original.clientWidth)}px!important;` +
      `height:${Math.max(original.scrollHeight, original.clientHeight)}px!important;` +
      `margin:0!important;padding:0!important;transform:translate(${-scrollLeft}px,${-scrollTop}px)!important;` +
      `transform-origin:0 0!important;${layoutStyle}`
    );
    while (target.firstChild) wrapper.appendChild(target.firstChild);
    target.appendChild(wrapper);
    if (computed.position === "static") {
      target.setAttribute("style", `${target.getAttribute("style") ?? ""}position:relative!important;`);
    }

    const stickyElements = Array.from(original.querySelectorAll<HTMLElement>("*"))
      .filter((element) => ownerWindow.getComputedStyle(element).position === "sticky")
      .filter((element) => nearestScrolledAncestor(element, scrolledSources, original) === original)
      .filter((element) => !hasStickyAncestor(element, original, ownerWindow))
      .filter((element) => !["caption", "col", "colgroup", "thead", "tbody", "tfoot", "tr", "th", "td"]
        .includes(element.tagName.toLowerCase()));

    for (const sticky of stickyElements) {
      const frozenSticky = cloneBySource.get(sticky) as HTMLElement | undefined;
      if (!frozenSticky || !target.contains(frozenSticky)) continue;
      const stickyBox = getStickyOverlayBox(sticky, original);
      if (!stickyBox || stickyBox.width <= 0 || stickyBox.height <= 0) continue;
      const overlay = frozenSticky.cloneNode(true) as HTMLElement;
      overlay.setAttribute("aria-hidden", "true");
      removeHtmlIds(overlay);
      overlay.setAttribute(
        "style",
        `position:absolute!important;left:${stickyBox.left}px!important;top:${stickyBox.top}px!important;` +
        `right:auto!important;bottom:auto!important;width:${stickyBox.width}px!important;` +
        `height:${stickyBox.height}px!important;margin:0!important;box-sizing:border-box!important;`
      );
      frozenSticky.setAttribute(
        "style",
        `${frozenSticky.getAttribute("style") ?? ""}visibility:hidden!important;`
      );
      target.appendChild(overlay);
    }
  }
}

function getStickyOverlayBox(
  sticky: HTMLElement,
  scrollport: HTMLElement
): { left: number; top: number; width: number; height: number } | null {
  let left = 0;
  let top = 0;
  let current: HTMLElement | null = sticky;
  while (current && current !== scrollport) {
    left += current.offsetLeft;
    top += current.offsetTop;
    const parent: Element | null = current.offsetParent;
    if (!(parent instanceof HTMLElement) || (parent !== scrollport && !scrollport.contains(parent))) return null;
    current = parent;
  }
  if (current !== scrollport) return null;
  return {
    left: left - scrollport.scrollLeft,
    top: top - scrollport.scrollTop,
    width: sticky.offsetWidth,
    height: sticky.offsetHeight
  };
}

function getScrollWrapperLayoutStyle(style: CSSStyleDeclaration): string {
  if (style.display.includes("flex")) {
    return `display:${style.display}!important;flex-direction:${style.flexDirection}!important;` +
      `flex-wrap:${style.flexWrap}!important;justify-content:${style.justifyContent}!important;` +
      `align-items:${style.alignItems}!important;align-content:${style.alignContent}!important;` +
      `column-gap:${style.columnGap}!important;row-gap:${style.rowGap}!important;`;
  }
  if (style.display.includes("grid")) {
    return `display:${style.display}!important;grid-template-columns:${style.gridTemplateColumns}!important;` +
      `grid-template-rows:${style.gridTemplateRows}!important;grid-auto-flow:${style.gridAutoFlow}!important;` +
      `column-gap:${style.columnGap}!important;row-gap:${style.rowGap}!important;`;
  }
  return "display:block!important;";
}

function nearestScrolledAncestor(
  element: Element,
  scrolledSources: Set<Element>,
  boundary: Element
): Element | null {
  let current = element.parentElement;
  while (current) {
    if (scrolledSources.has(current)) return current;
    if (current === boundary) return boundary;
    current = current.parentElement;
  }
  return null;
}

function hasStickyAncestor(element: Element, boundary: Element, ownerWindow: Window): boolean {
  let current = element.parentElement;
  while (current && current !== boundary) {
    if (ownerWindow.getComputedStyle(current).position === "sticky") return true;
    current = current.parentElement;
  }
  return false;
}

function removeHtmlIds(root: HTMLElement): void {
  root.removeAttribute("id");
  for (const element of Array.from(root.querySelectorAll("[id]"))) element.removeAttribute("id");
}

async function inlineMediaElement(
  original: Element,
  target: Element,
  budget: InlineMediaBudget,
  signal?: AbortSignal
): Promise<string | null> {
  const tag = original.tagName.toLowerCase();
  if (tag === "canvas") {
    const canvas = original as HTMLCanvasElement;
    if (!isInlineMediaGeometrySafe(canvas.width, canvas.height) || !canAttemptInlineMedia(budget)) {
      replaceWithSnapshotPlaceholder(target, "Canvas");
      return "canvas";
    }
    try {
      ensureNotAborted(signal);
      const blob = await canvasToPngBlob(canvas, signal);
      const dataUrl = await inlinePngBlobToDataUrl(blob, budget, signal);
      if (!dataUrl) throw new Error("Canvas returned an unsafe PNG.");
      replaceWithSnapshotImage(target, dataUrl, canvas.width, canvas.height);
    } catch {
      ensureNotAborted(signal);
      replaceWithSnapshotPlaceholder(target, "Canvas");
      return "canvas";
    }
    return null;
  }

  if (tag !== "img") return null;
  const image = original as HTMLImageElement;
  const clone = target as HTMLImageElement;
  clone.removeAttribute("loading");
  clone.setAttribute("decoding", "sync");
  if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1) {
    replaceWithSnapshotPlaceholder(target, image.alt || "Image");
    return describeUnresolvedImage(image);
  }
  if (!canAttemptInlineMedia(budget)) {
    replaceWithSnapshotPlaceholder(target, image.alt || "Image");
    return describeUnresolvedImage(image);
  }
  try {
    ensureNotAborted(signal);
    const blob = await rasterizeImageElement(image, signal);
    const dataUrl = blob ? await inlinePngBlobToDataUrl(blob, budget, signal) : null;
    if (dataUrl) {
      clone.src = dataUrl;
      clone.removeAttribute("srcset");
      clone.removeAttribute("sizes");
    } else {
      replaceWithSnapshotPlaceholder(target, image.alt || "Image");
      return describeUnresolvedImage(image);
    }
  } catch {
    ensureNotAborted(signal);
    replaceWithSnapshotPlaceholder(target, image.alt || "Image");
    return describeUnresolvedImage(image);
  }
  return null;
}

function createInlineMediaBudget(): InlineMediaBudget {
  return { count: 0, totalBytes: 0, totalDataUrlChars: 0 };
}

function canAttemptInlineMedia(budget: InlineMediaBudget): boolean {
  return budget.count < MAX_INLINE_MEDIA_COUNT &&
    budget.totalBytes < MAX_TOTAL_INLINE_MEDIA_BYTES &&
    budget.totalDataUrlChars < MAX_TOTAL_INLINE_MEDIA_DATA_URL_CHARS;
}

function reserveInlineMediaDataUrl(dataUrl: string, budget: InlineMediaBudget): boolean {
  const bytes = getBase64DataUrlByteLength(dataUrl);
  const dataUrlChars = dataUrl.length;
  if (bytes === null || bytes > MAX_INLINE_MEDIA_BYTES || dataUrlChars > MAX_INLINE_MEDIA_DATA_URL_CHARS) {
    return false;
  }
  if (budget.count + 1 > MAX_INLINE_MEDIA_COUNT ||
      budget.totalBytes + bytes > MAX_TOTAL_INLINE_MEDIA_BYTES ||
      budget.totalDataUrlChars + dataUrlChars > MAX_TOTAL_INLINE_MEDIA_DATA_URL_CHARS) {
    return false;
  }
  budget.count += 1;
  budget.totalBytes += bytes;
  budget.totalDataUrlChars += dataUrlChars;
  return true;
}

function getInlineMediaReservation(
  bytes: number,
  budget: InlineMediaBudget
): { dataUrlChars: number } | null {
  const dataUrlChars = "data:image/png;base64,".length + Math.ceil(bytes / 3) * 4;
  if (!Number.isSafeInteger(bytes) || bytes < 9 || bytes > MAX_INLINE_MEDIA_BYTES ||
      dataUrlChars > MAX_INLINE_MEDIA_DATA_URL_CHARS) {
    return null;
  }
  if (budget.count + 1 > MAX_INLINE_MEDIA_COUNT ||
      budget.totalBytes + bytes > MAX_TOTAL_INLINE_MEDIA_BYTES ||
      budget.totalDataUrlChars + dataUrlChars > MAX_TOTAL_INLINE_MEDIA_DATA_URL_CHARS) {
    return null;
  }
  return { dataUrlChars };
}

async function inlinePngBlobToDataUrl(
  blob: Blob,
  budget: InlineMediaBudget,
  signal?: AbortSignal
): Promise<string | null> {
  ensureNotAborted(signal);
  const reservation = getInlineMediaReservation(blob.size, budget);
  if (!reservation) return null;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  ensureNotAborted(signal);
  if (bytes.byteLength !== blob.size || !hasPngSignature(bytes)) return null;
  const dataUrl = pngBytesToDataUrl(bytes);
  if (dataUrl.length !== reservation.dataUrlChars) return null;
  // Another asynchronous encoder may have consumed the shared budget while
  // this blob was being buffered. Revalidate immediately before the
  // synchronous commit so cumulative limits cannot be oversubscribed.
  const currentReservation = getInlineMediaReservation(bytes.byteLength, budget);
  if (!currentReservation || currentReservation.dataUrlChars !== dataUrl.length) return null;

  budget.count += 1;
  budget.totalBytes += bytes.byteLength;
  budget.totalDataUrlChars += dataUrl.length;
  return dataUrl;
}

function pngBytesToDataUrl(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function getBase64DataUrlByteLength(dataUrl: string): number | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.slice(0, comma).toLowerCase().endsWith(";base64")) return null;
  const payloadLength = dataUrl.length - comma - 1;
  if (payloadLength < 4 || payloadLength % 4 !== 0) return null;
  const padding = dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0;
  return payloadLength / 4 * 3 - padding;
}

function isInlineMediaGeometrySafe(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) &&
    Number.isInteger(width) && Number.isInteger(height) &&
    width > 0 && height > 0 &&
    width <= MAX_INLINE_MEDIA_DIMENSION && height <= MAX_INLINE_MEDIA_DIMENSION &&
    width * height <= MAX_INLINE_MEDIA_PIXELS;
}

function describeUnresolvedImage(image: HTMLImageElement): string {
  const identifier = image.alt || image.currentSrc || image.src || "unavailable";
  return `image:${identifier.slice(0, 160)}`;
}

function findExternalSvgResources(root: HTMLElement): string[] {
  const unresolved: string[] = [];
  for (const element of Array.from(root.querySelectorAll("svg image, svg use"))) {
    const href = element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "";
    if (!href || href.startsWith("#") || href.startsWith("data:")) continue;
    unresolved.push(href);
  }
  return unresolved;
}

async function rasterizeImageElement(
  image: HTMLImageElement,
  signal?: AbortSignal
): Promise<Blob | null> {
  const ownerDocument = image.ownerDocument;
  const rect = image.getBoundingClientRect();
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 0 || rect.height < 0) return null;
  const deviceScale = clamp(ownerDocument.defaultView?.devicePixelRatio ?? 1, 1, 2);
  const desiredWidth = Math.max(1, Math.ceil(rect.width * deviceScale));
  const desiredHeight = Math.max(1, Math.ceil(rect.height * deviceScale));
  const { width, height } = getSafeRasterDimensions(desiredWidth, desiredHeight, {
    maxDimension: MAX_INLINE_MEDIA_DIMENSION,
    maxPixels: MAX_INLINE_MEDIA_PIXELS
  });
  if (!isInlineMediaGeometrySafe(width, height)) return null;
  const canvas = ownerDocument.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = width < desiredWidth || height < desiredHeight ? "high" : "medium";
  context.drawImage(image, 0, 0, width, height);
  return canvasToPngBlob(canvas, signal);
}

/** @internal Exported only so the media safety invariants can be unit-tested without a browser. */
export const domSnapshotMediaTestApi = {
  createBudget: createInlineMediaBudget,
  getBase64DataUrlByteLength,
  inlineMediaElement,
  isGeometrySafe: isInlineMediaGeometrySafe,
  reserveDataUrl: reserveInlineMediaDataUrl,
  limits: {
    maxDimension: MAX_INLINE_MEDIA_DIMENSION,
    maxPixels: MAX_INLINE_MEDIA_PIXELS,
    maxItemBytes: MAX_INLINE_MEDIA_BYTES,
    maxTotalBytes: MAX_TOTAL_INLINE_MEDIA_BYTES,
    maxItemDataUrlChars: MAX_INLINE_MEDIA_DATA_URL_CHARS,
    maxTotalDataUrlChars: MAX_TOTAL_INLINE_MEDIA_DATA_URL_CHARS,
    maxCount: MAX_INLINE_MEDIA_COUNT
  }
};

/** @internal Tree-shaken from the plugin bundle; exposes memory guards to pure tests. */
export const domSnapshotMemoryTestApi = {
  limits: {
    maxSourceChars: MAX_SNAPSHOT_MARKUP_CHARS,
    maxContentNodes: MAX_SNAPSHOT_CONTENT_NODES,
    maxStyleChars: MAX_SERIALIZED_STYLE_CHARS
  },
  createBudget: (): SnapshotMemoryBudget => ({ retainedChars: 0 }),
  reserveChars: reserveSnapshotChars,
  assertSourceWithinBudget: assertSourceDomWithinBudget,
  removeComments: removeSnapshotComments,
  serializeStyle: (style: CSSStyleDeclaration): Promise<string> => {
    const controller = new AbortController();
    return serializeComputedStyle(style, {} as Document, {
      values: new Map(),
      totalBytes: 0,
      fetchQueue: Promise.resolve(),
      signal: controller.signal,
      unresolved: new Set()
    });
  }
};

function replaceWithSnapshotImage(target: Element, dataUrl: string, width: number, height: number): void {
  const ownerDocument = target.ownerDocument;
  const image = ownerDocument.createElement("img");
  for (const attribute of Array.from(target.attributes)) image.setAttribute(attribute.name, attribute.value);
  image.removeAttribute(SNAPSHOT_ATTRIBUTE);
  image.setAttribute(SNAPSHOT_ATTRIBUTE, target.getAttribute(SNAPSHOT_ATTRIBUTE) ?? "");
  image.src = dataUrl;
  image.width = Math.max(1, width);
  image.height = Math.max(1, height);
  target.replaceWith(image);
}

function replaceWithSnapshotPlaceholder(target: Element, label: string): void {
  const placeholder = target.ownerDocument.createElement("div");
  for (const attribute of Array.from(target.attributes)) {
    if (attribute.name === "src" || attribute.name === "srcset" || attribute.name === "sizes") continue;
    placeholder.setAttribute(attribute.name, attribute.value);
  }
  placeholder.setAttribute("role", "img");
  placeholder.setAttribute("aria-label", label);
  placeholder.textContent = label;
  target.replaceWith(placeholder);
}

function stripExecutableAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    if (/^on/iu.test(attribute.name)) element.removeAttribute(attribute.name);
  }
}

function removeUnsafeSnapshotNodes(root: HTMLElement): void {
  for (const element of Array.from(root.querySelectorAll(
    ".mobile-pdf-exporter-skip, .collapse-indicator, .heading-collapse-indicator, .markdown-embed-link, .copy-code-button"
  ))) {
    element.remove();
  }
  for (const style of Array.from(root.querySelectorAll("style"))) style.remove();
  for (const source of Array.from(root.querySelectorAll("picture source, video source, audio source"))) source.remove();
  for (const element of Array.from(root.querySelectorAll("script, iframe, webview, object, embed"))) {
    const placeholder = root.ownerDocument.createElement("div");
    placeholder.setAttribute("aria-hidden", "true");
    if (element instanceof HTMLElement || element instanceof SVGElement) {
      placeholder.setAttribute("style", element.getAttribute("style") ?? "");
    }
    placeholder.textContent = element.getAttribute("title") ?? element.getAttribute("src") ?? "";
    element.replaceWith(placeholder);
  }
}

async function inlineCssUrls(
  value: string,
  ownerDocument: Document,
  cache: CssUrlCache,
  baseUrl = ownerDocument.baseURI
): Promise<string> {
  const matches = Array.from(value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/giu));
  if (!matches.length) return value;
  let result = value;
  for (const match of matches) {
    const rawUrl = match[2]?.trim() ?? "";
    if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("#")) continue;
    const dataUrl = await resolveResourceDataUrl(rawUrl, ownerDocument, cache, baseUrl);
    if (!dataUrl) {
      cache.unresolved.add(rawUrl);
      continue;
    }
    result = result.replace(match[0], `url("${dataUrl}")`);
  }
  return result;
}

async function resolveResourceDataUrl(
  rawUrl: string,
  ownerDocument: Document,
  cache: CssUrlCache,
  baseUrl = ownerDocument.baseURI
): Promise<string | null> {
  const resolvedBaseUrl = baseUrl || ownerDocument.location?.href || "";
  let absoluteUrl = rawUrl;
  try {
    absoluteUrl = new URL(rawUrl, resolvedBaseUrl).href;
  } catch {
    // Keep the original value when a custom app URL cannot be normalized.
  }
  if (!isLocalSnapshotResource(absoluteUrl, ownerDocument.baseURI || resolvedBaseUrl)) return null;
  const cached = cache.values.get(absoluteUrl);
  if (cached) return cached;
  if (cache.values.size >= MAX_INLINE_RESOURCE_COUNT) return null;

  // Computed styles are serialized concurrently. Keep network bodies on one
  // bounded lane so many chunked CSS/font/image responses cannot temporarily
  // occupy the heap before their shared cumulative budget is committed.
  const previousFetch = cache.fetchQueue;
  let releaseFetch!: () => void;
  cache.fetchQueue = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const request = (async (): Promise<string | null> => {
    await previousFetch;
    let controller: AbortController | null = null;
    let abortFromPreparation: (() => void) | null = null;
    let timeout = 0;
    try {
      ensureNotAborted(cache.signal);
      const remainingBytes = MAX_TOTAL_INLINE_RESOURCE_BYTES - cache.totalBytes;
      if (remainingBytes <= 0) return null;
      controller = new AbortController();
      abortFromPreparation = (): void => controller?.abort();
      cache.signal.addEventListener("abort", abortFromPreparation, { once: true });
      timeout = ownerDocument.defaultView?.setTimeout(
        () => controller?.abort(),
        RESOURCE_FETCH_TIMEOUT_MS
      ) ?? 0;
      const response = await ownerDocument.defaultView?.fetch(absoluteUrl, {
        signal: controller.signal,
        cache: "force-cache",
        credentials: "same-origin"
      });
      if (!response?.ok) return null;
      const blob = await readResponseBlobWithinLimit(
        response,
        Math.min(MAX_INLINE_RESOURCE_BYTES, remainingBytes),
        controller.signal
      );
      if (blob.size <= 0 || cache.totalBytes + blob.size > MAX_TOTAL_INLINE_RESOURCE_BYTES) return null;
      cache.totalBytes += blob.size;
      return await blobToDataUrl(blob, controller.signal);
    } catch (error) {
      if (cache.signal.aborted) throw error;
      return null;
    } finally {
      ownerDocument.defaultView?.clearTimeout(timeout);
      if (abortFromPreparation) cache.signal.removeEventListener("abort", abortFromPreparation);
      releaseFetch();
    }
  })();
  cache.values.set(absoluteUrl, request);
  return request;
}

function isLocalSnapshotResource(resourceUrl: string, documentUrl: string): boolean {
  try {
    const resource = new URL(resourceUrl, documentUrl);
    if (["data:", "blob:", "file:", "app:", "capacitor:"].includes(resource.protocol)) return true;
    const documentLocation = new URL(documentUrl);
    return resource.origin === documentLocation.origin;
  } catch {
    return false;
  }
}

async function blobToDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  ensureNotAborted(signal);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  ensureNotAborted(signal);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  ensureNotAborted(signal);
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function buildPageSvg(options: {
  sourceMarkup: string;
  pseudoCss: string;
  sourceWidthPx: number;
  pageTopPx: number;
  pageHeightPx: number;
  backgroundCss: string;
}): string {
  const width = roundDimension(options.sourceWidthPx);
  const height = roundDimension(options.pageHeightPx);
  const pageTop = Number(options.pageTopPx.toFixed(3));
  const background = escapeHtmlAttribute(options.backgroundCss || "#fff");
  const pseudoStyle = options.pseudoCss ? `<style>${escapeXmlText(options.pseudoCss)}</style>` : "";
  return [
    `<svg xmlns="${SVG_NAMESPACE}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
    `<div xmlns="${XHTML_NAMESPACE}" style="position:relative;box-sizing:border-box;width:${width}px;height:${height}px;overflow:hidden;margin:0;padding:0;background:${background};">`,
    pseudoStyle,
    `<div style="position:absolute;box-sizing:border-box;left:0;top:${-pageTop}px;width:${width}px;margin:0;padding:0;">`,
    options.sourceMarkup,
    "</div></div></foreignObject></svg>"
  ].join("");
}

async function rasterizeSvgPage(
  ownerDocument: Document,
  svgMarkup: string,
  options: {
    widthPx: number;
    heightPx: number;
    scale: number;
    backgroundCss: string;
    grayscale: boolean;
  }
): Promise<Uint8Array> {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("DOM snapshot requires a window.");
  let objectUrl: string | null = null;
  const getObjectUrl = (): string => {
    if (!objectUrl) {
      const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
      objectUrl = ownerWindow.URL.createObjectURL(blob);
    }
    return objectUrl;
  };
  const safari = isSafariWebKit(ownerWindow.navigator.userAgent);
  const sources = safari
    ? [() => svgMarkupToDataUrl(svgMarkup), getObjectUrl]
    : [getObjectUrl, () => svgMarkupToDataUrl(svgMarkup)];
  let lastError: unknown = null;
  try {
    for (const getSource of sources) {
      try {
        const canvas = ownerDocument.createElement("canvas");
        const pixelWidth = Math.max(1, Math.ceil(options.widthPx * options.scale));
        const pixelHeight = Math.max(1, Math.ceil(options.heightPx * options.scale));
        if (pixelWidth > MAX_SNAPSHOT_CANVAS_DIMENSION ||
            pixelHeight > MAX_SNAPSHOT_CANVAS_DIMENSION ||
            pixelWidth * pixelHeight > MAX_SNAPSHOT_CANVAS_PIXELS) {
          throw new Error(`DOM snapshot canvas exceeds the mobile limit (${pixelWidth} x ${pixelHeight}).`);
        }
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("DOM snapshot canvas is unavailable.");
        context.setTransform(options.scale, 0, 0, options.scale, 0, 0);
        context.fillStyle = options.backgroundCss || "#fff";
        context.fillRect(0, 0, options.widthPx, options.heightPx);

        const image = await loadSnapshotImage(ownerDocument, getSource(), SNAPSHOT_TIMEOUT_MS);
        const warmupAttempts = safari ? 2 : 1;
        for (let attempt = 0; attempt < warmupAttempts; attempt += 1) {
          if (attempt > 0) {
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.setTransform(options.scale, 0, 0, options.scale, 0, 0);
            context.fillStyle = options.backgroundCss || "#fff";
            context.fillRect(0, 0, options.widthPx, options.heightPx);
          }
          context.drawImage(image, 0, 0, options.widthPx, options.heightPx);
          if (attempt + 1 < warmupAttempts) await nextFrame(ownerWindow);
        }
        if (options.grayscale) applyGrayscale(context, canvas.width, canvas.height);
        return await canvasToPngBytes(canvas);
      } catch (error) {
        lastError = error;
      }
    }
  } finally {
    if (objectUrl) ownerWindow.URL.revokeObjectURL(objectUrl);
  }
  throw lastError instanceof Error ? lastError : new Error("WebView could not rasterize the DOM snapshot.");
}

async function loadSnapshotImage(ownerDocument: Document, src: string, timeoutMs: number): Promise<HTMLImageElement> {
  const image = ownerDocument.createElement("img");
  image.setAttribute("decoding", "sync");
  await new Promise<void>((resolve, reject) => {
    let timeout = 0;
    const finish = (error?: Error): void => {
      ownerDocument.defaultView?.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    image.onload = () => finish();
    image.onerror = () => finish(new Error("WebView could not rasterize the DOM snapshot."));
    timeout = ownerDocument.defaultView?.setTimeout(
      () => finish(new Error("DOM snapshot rasterization timed out.")),
      timeoutMs
    ) ?? 0;
    image.src = src;
  });
  return image;
}

function applyGrayscale(context: CanvasRenderingContext2D, width: number, height: number): void {
  const image = context.getImageData(0, 0, width, height);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const gray = Math.round(image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722);
    image.data[offset] = gray;
    image.data[offset + 1] = gray;
    image.data[offset + 2] = gray;
  }
  context.putImageData(image, 0, 0);
}

async function waitForDocumentFonts(ownerDocument: Document, timeoutMs: number): Promise<void> {
  const fonts = ownerDocument.fonts;
  if (!fonts?.ready) return;
  await Promise.race([
    fonts.ready.then(() => undefined),
    new Promise<void>((resolve) => ownerDocument.defaultView?.setTimeout(resolve, timeoutMs))
  ]);
  await nextFrame(ownerDocument.defaultView);
}

async function nextFrame(ownerWindow: Window | null): Promise<void> {
  if (!ownerWindow) return;
  await new Promise<void>((resolve) => {
    const timeout = ownerWindow.setTimeout(resolve, 80);
    ownerWindow.requestAnimationFrame(() => {
      ownerWindow.clearTimeout(timeout);
      resolve();
    });
  });
}

function isSafariWebKit(userAgent: string): boolean {
  return /AppleWebKit/iu.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)/iu.test(userAgent);
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("WebView returned an empty PNG snapshot.");
  if (blob.size > MAX_SNAPSHOT_PNG_BYTES) {
    throw new Error(`DOM snapshot PNG exceeds the mobile limit (${blob.size} bytes).`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!hasPngSignature(bytes)) throw new Error("WebView returned an invalid PNG snapshot.");
  return bytes;
}

function svgMarkupToDataUrl(markup: string): string {
  const bytes = new TextEncoder().encode(markup);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/svg+xml;charset=utf-8;base64,${btoa(binary)}`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function roundDimension(value: number): number {
  return Math.max(1, Math.ceil(value * 1000) / 1000);
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid DOM snapshot ${label}.`);
  return value;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid DOM snapshot ${label}.`);
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  let timeout = 0;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = window.setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => window.clearTimeout(timeout));
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("DOM snapshot preparation was cancelled.");
}

async function yieldToEventLoop(ownerWindow: Window): Promise<void> {
  await new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, 0));
}
