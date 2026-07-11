import { prepareDomSnapshot } from "../src/dom-snapshot";
import {
  computePageBreaks,
  getFixedPageSliceLayout,
  isRenderedLeadingWhitespaceBoundaryCompatible,
  isRenderedTrailingWhitespaceBoundaryCompatible,
  isRenderedWhitespaceBoundaryCompatible,
  measureRenderedWhitespaceSeparator,
  segmentTextGraphemes
} from "../src/text-layout";

interface RectRecord { x: number; y: number; width: number; height: number }
interface RegionRecord { id: string; source: RectRecord; snapshot: RectRecord }
interface CaseRecord { id: string; source: RectRecord; snapshot: RectRecord; regions: RegionRecord[] }
interface RasterComparisonMetrics {
  label: string;
  width: number;
  height: number;
  candidateWidth: number;
  candidateHeight: number;
  candidateCanvasWarmupFrames: number;
  baseOpaquePixelRatio: number;
  candidateOpaquePixelRatio: number;
  contentPixelRatio: number;
  mismatchedPixelRatio: number;
  normalizedError: number;
}
interface RasterArtifactRecord {
  oneXPngBase64: string;
  twoXPngBase64: string;
  metrics: RasterComparisonMetrics;
}

type RasterDiagnosticWindow = typeof window & {
  __mobilePdfRasterArtifacts?: RasterArtifactRecord;
};

async function run(): Promise<void> {
  hydrateAdversarialSliceFixtures();
  initializeScrollableFixtures();
  await document.fonts.ready;
  await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => undefined)));
  paintFixtureCanvases();
  await nextFrame();
  const boundaryCoverage = configureComputedBoundaryFixture();
  assertDomWhitespaceRegression();
  const primaryRasterScale = getPrimaryRasterScale();
  const coverage = { ...assertAdversarialFixtureCoverage(), ...boundaryCoverage, primaryRasterScale };

  const results: CaseRecord[] = [];
  for (const pair of Array.from(document.querySelectorAll<HTMLElement>(".pair"))) {
    const source = pair.querySelector<HTMLElement>(".snapshot-source");
    const referenceViewport = pair.querySelector<HTMLElement>(".snapshot-reference");
    const output = pair.querySelector<HTMLElement>(".snapshot-output");
    const id = pair.dataset.case ?? "unknown";
    if (!source || !output) throw new Error(`Missing fixture nodes for ${id}.`);

    const pageTopPx = Number(pair.dataset.pageTop ?? 0);
    const sourceRect = source.getBoundingClientRect();
    const physicalPageHeightPx = Number(pair.dataset.pageHeight ?? sourceRect.height);
    const nonuniformPageBottomPx = Number(pair.dataset.nonuniformPageBottom);
    const nonuniformSlice = Number.isFinite(nonuniformPageBottomPx)
      ? getFixedPageSliceLayout(pageTopPx, nonuniformPageBottomPx, physicalPageHeightPx)
      : null;
    const pageHeightPx = nonuniformSlice?.contentHeightPx ?? physicalPageHeightPx;
    if (nonuniformSlice && nonuniformSlice.blankHeightPx <= 0) {
      throw new Error(`${id} must leave a nonzero blank physical-page tail.`);
    }
    if (pageTopPx + pageHeightPx > sourceRect.height + 0.5) {
      throw new Error(`${id} requests pixels below its ${sourceRect.height}px source.`);
    }
    let referenceElement = source;
    if (referenceViewport) {
      referenceViewport.style.height = `${pageHeightPx}px`;
      const referenceClone = source.cloneNode(true) as HTMLElement;
      referenceClone.classList.remove("snapshot-source");
      referenceClone.style.top = `${-pageTopPx}px`;
      referenceViewport.replaceChildren(referenceClone);
      referenceElement = referenceViewport;
    }
    const prepared = await prepareDomSnapshot(source, {
      sourceWidthPx: sourceRect.width,
      backgroundCss: getComputedStyle(source).backgroundColor
    });
    const pngBytes = await prepared.renderPage({
      pageTopPx,
      pageHeightPx,
      scale: primaryRasterScale,
      grayscale: false
    });
    const image = document.createElement("img");
    image.alt = `${id} snapshot`;
    const snapshotObjectUrl = URL.createObjectURL(new Blob([pngBytes], { type: "image/png" }));
    image.src = snapshotObjectUrl;
    await image.decode();
    if (image.naturalWidth !== Math.ceil(sourceRect.width * primaryRasterScale) ||
        image.naturalHeight !== Math.ceil(pageHeightPx * primaryRasterScale)) {
      throw new Error(
        `${primaryRasterScale}x primary snapshot dimensions regressed for ${id}: ` +
        `${image.naturalWidth}x${image.naturalHeight}.`
      );
    }
    output.style.height = `${pageHeightPx}px`;
    output.replaceChildren(image);
    await nextFrame();

    if (id === "inline-korean") {
      const alternateScale = primaryRasterScale > 1 ? 1 : 2;
      const alternateScaleBytes = await prepared.renderPage({
        pageTopPx,
        pageHeightPx,
        scale: alternateScale,
        grayscale: false
      });
      const alternateScaleImage = await decodePng(alternateScaleBytes);
      if (alternateScaleImage.naturalWidth !== Math.ceil(sourceRect.width * alternateScale) ||
          alternateScaleImage.naturalHeight !== Math.ceil(pageHeightPx * alternateScale)) {
        throw new Error(`${alternateScale}x snapshot dimensions regressed for ${id}.`);
      }
      try {
        const oneXImage = primaryRasterScale > 1 ? alternateScaleImage : image;
        const oneXBytes = primaryRasterScale > 1 ? alternateScaleBytes : pngBytes;
        const twoXImage = primaryRasterScale > 1 ? image : alternateScaleImage;
        const twoXBytes = primaryRasterScale > 1 ? pngBytes : alternateScaleBytes;
        await assertRasterContentMatches(oneXImage, twoXImage, "2x snapshot", (metrics) => {
          recordRasterArtifacts(oneXBytes, twoXBytes, metrics);
        });
        const safariBytes = await withSafariUserAgent(() => prepared.renderPage({
          pageTopPx,
          pageHeightPx,
          scale: 1,
          grayscale: false
        }));
        const safariImage = await decodePng(safariBytes);
        try {
          if (safariImage.naturalWidth !== oneXImage.naturalWidth ||
              safariImage.naturalHeight !== oneXImage.naturalHeight) {
            throw new Error("Safari data-URL branch returned unexpected dimensions.");
          }
          await assertRasterContentMatches(oneXImage, safariImage, "Safari data-URL warmup snapshot");
        } finally {
          URL.revokeObjectURL(safariImage.src);
        }
      } finally {
        URL.revokeObjectURL(alternateScaleImage.src);
      }
    }
    if (id === "table-callout") {
      const grayscaleBytes = await prepared.renderPage({
        pageTopPx,
        pageHeightPx,
        scale: 1,
        grayscale: true
      });
      await assertGrayscalePng(grayscaleBytes);
    }
    if (nonuniformSlice && image.naturalHeight !== Math.ceil(nonuniformSlice.contentHeightPx * primaryRasterScale)) {
      throw new Error(
        `Native snapshot requested ${nonuniformSlice.contentHeightPx}px at ${primaryRasterScale}x for ${id}, ` +
        `but returned ${image.naturalHeight}px.`
      );
    }

    const referenceRect = referenceElement.getBoundingClientRect();
    // Compare the clipped output viewport, not the image's ceil-rounded
    // intrinsic height (which can differ from a fractional CSS height by 1px).
    const snapshotRect = output.getBoundingClientRect();
    results.push({
      id,
      source: roundRect(referenceRect),
      snapshot: roundRect(snapshotRect),
      regions: collectFeatureRegions(source, sourceRect, referenceRect, snapshotRect, pageTopPx, pageHeightPx)
    });
    URL.revokeObjectURL(snapshotObjectUrl);
  }
  assertRequiredFeatureRegions(results);

  const resultNode = document.createElement("script");
  resultNode.id = "render-fidelity-results";
  resultNode.type = "application/json";
  resultNode.textContent = JSON.stringify({ ok: true, cases: results, coverage });
  document.body.appendChild(resultNode);
  document.documentElement.dataset.testReady = "true";
}

function assertRequiredFeatureRegions(results: CaseRecord[]): void {
  const requiredByCase: Record<string, string[]> = {
    "inline-korean": ["mark:0", "del:0", "code:0", "badge:0"],
    "table-callout": ["table:0", "callout:0", "blockquote:0"],
    "lists-code": ["input:0", "pre:0"],
    "media-dark": ["svg:0", "canvas:0", "image:0"],
    "adversarial-text": [
      "long-unbroken:0", "long-url:0", "negative-tight:0", "mixed-direction:0",
      "whitespace-break-spaces:0", "gradient-text:0", "line-clamp-text:0"
    ],
    "adversarial-layers": [
      "transform-root:0", "position-stage:0", "absolute-chip:0", "fixed-chip:0",
      "absolute-chip-core:0", "fixed-chip-core:0", "sticky-scrollport:0", "sticky-chip:0",
      "clip-card:0", "alpha-stack:0"
    ],
    "complex-table": ["complex-table:0"],
    "layout-exotics": [
      "multicol:0", "vertical-writing:0", "ruby:0", "first-letter-probe:0",
      "first-letter-before-glyph:0", "first-letter-aria:0", "first-line:0", "live-state:0"
    ],
    "pagination-nonuniform-a": ["page-stress-band:0"],
    "pagination-nonuniform-b": ["page-stress-band:1", "page-stress-band:2"],
    "pagination-nonuniform-c": ["page-stress-band:3"],
    "pagination-nonuniform-d": ["page-stress-band:4"],
    "pagination-slice": ["table:0"],
    "pagination-text-boundary": ["boundary-crossing-line:0"]
  };
  const byCase = new Map(results.map((result) => [result.id, result]));
  for (const [caseId, requiredIds] of Object.entries(requiredByCase)) {
    const result = byCase.get(caseId);
    if (!result) throw new Error(`Missing required visual case: ${caseId}.`);
    const present = new Set(result.regions.map((region) => region.id));
    const missing = requiredIds.filter((id) => !present.has(id));
    if (missing.length > 0) {
      throw new Error(`${caseId} silently skipped required visual region(s): ${missing.join(", ")}.`);
    }
  }
}

function configureComputedBoundaryFixture(): {
  computedBoundaryOverflowPx: number;
  computedBoundaryBreakPx: number;
} {
  const pair = requiredBoundaryElement<HTMLElement>(".computed-boundary-pair");
  const source = requiredBoundaryElement<HTMLElement>(".computed-boundary-source");
  const line = requiredBoundaryElement<HTMLElement>(".boundary-crossing-line");
  const physicalPageHeightPx = Number(pair.dataset.computedPageHeight);
  if (!Number.isFinite(physicalPageHeightPx) || physicalPageHeightPx <= 0) {
    throw new Error("Computed boundary fixture has an invalid physical page height.");
  }

  const textNode = Array.from(line.childNodes).find((node): node is Text => node.nodeType === Node.TEXT_NODE);
  if (!textNode) throw new Error("Computed boundary fixture lost its text node.");
  const range = document.createRange();
  range.selectNodeContents(textNode);
  let sourceRect = source.getBoundingClientRect();
  let lineRect = firstRangeRect(range);
  const targetBottom = physicalPageHeightPx + 0.75;
  const currentTop = Number.parseFloat(getComputedStyle(line).top) || 0;
  line.style.top = `${currentTop + targetBottom - (lineRect.bottom - sourceRect.top)}px`;
  sourceRect = source.getBoundingClientRect();
  lineRect = firstRangeRect(range);
  range.detach();

  const fragment = {
    top: lineRect.top - sourceRect.top,
    bottom: lineRect.bottom - sourceRect.top,
    priority: 1
  };
  const pageBreaks = computePageBreaks(sourceRect.height, physicalPageHeightPx, [fragment]);
  if (pageBreaks.length < 3) throw new Error("Computed boundary fixture did not create a following page.");
  const pageBreakPx = pageBreaks[1];
  if (fragment.top < pageBreakPx && fragment.bottom > pageBreakPx) {
    throw new Error("Production pagination left the boundary through the measured text rectangle.");
  }
  if (pageBreakPx > fragment.top || fragment.top - pageBreakPx > 0.0011) {
    throw new Error(
      `Production pagination did not place the measured line at the following page start ` +
      `(${pageBreakPx} vs ${fragment.top}).`
    );
  }
  const pageBottomPx = pageBreaks[2];
  pair.dataset.pageTop = String(pageBreakPx);
  pair.dataset.pageHeight = String(physicalPageHeightPx);
  pair.dataset.nonuniformPageBottom = String(pageBottomPx);

  return {
    computedBoundaryOverflowPx: fragment.bottom - physicalPageHeightPx,
    computedBoundaryBreakPx: pageBreakPx
  };
}

function requiredBoundaryElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing computed boundary fixture element: ${selector}.`);
  return element;
}

function firstRangeRect(range: Range): DOMRect {
  const rect = Array.from(range.getClientRects()).find((candidate) =>
    candidate.width > 0.1 && candidate.height > 0.1
  );
  if (!rect) throw new Error("Computed boundary fixture text has no measurable rectangle.");
  return rect;
}

function hydrateAdversarialSliceFixtures(): void {
  for (const pair of Array.from(document.querySelectorAll<HTMLElement>("[data-slice-template]"))) {
    const templateId = pair.dataset.sliceTemplate;
    const host = pair.querySelector<HTMLElement>(".slice-model-host");
    const template = templateId ? document.getElementById(templateId) : null;
    if (!host || !(template instanceof HTMLTemplateElement)) {
      throw new Error(`Missing pagination template for ${pair.dataset.case ?? "unknown"}.`);
    }
    host.replaceChildren(template.content.cloneNode(true));
  }
}

function initializeScrollableFixtures(): void {
  for (const scrollport of Array.from(document.querySelectorAll<HTMLElement>(".sticky-scrollport"))) {
    scrollport.scrollTop = 62;
  }
  const details = document.querySelector<HTMLDetailsElement>(".live-details");
  const textarea = document.querySelector<HTMLTextAreaElement>(".live-textarea");
  const select = document.querySelector<HTMLSelectElement>(".live-select");
  if (!details || !textarea || !select) throw new Error("Missing live-state form fixtures.");
  details.open = true;
  textarea.value = "라이브 값 1\nlive value 2";
  select.selectedIndex = 2;
}

function assertAdversarialFixtureCoverage() {
  const required = <T extends Element>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Missing adversarial fixture: ${selector}.`);
    return element;
  };
  const style = (selector: string): CSSStyleDeclaration => getComputedStyle(required(selector));

  const longKorean = required<HTMLElement>(".long-unbroken").textContent ?? "";
  if (longKorean.length < 250 || /\s/u.test(longKorean)) {
    throw new Error("Long unbroken Korean fixture is not adversarial enough.");
  }
  const longUrl = required<HTMLElement>(".long-url").textContent ?? "";
  if (longUrl.length < 220 || /\s/u.test(longUrl)) {
    throw new Error("Long URL fixture is not adversarial enough.");
  }
  if (Number.parseFloat(style(".negative-tight").letterSpacing) >= 0) {
    throw new Error("Negative letter-spacing fixture lost its negative spacing.");
  }

  const rootStyle = style(".transform-root");
  const middleStyle = style(".transform-middle");
  const childStyle = style(".transform-child");
  if (rootStyle.transform === "none" || middleStyle.transform === "none" || childStyle.transform === "none") {
    throw new Error("Nested transform fixture is incomplete.");
  }
  if (Number.parseFloat(rootStyle.opacity) >= 1 || Number.parseFloat(middleStyle.opacity) >= 1) {
    throw new Error("Nested opacity fixture is incomplete.");
  }
  if (rootStyle.filter === "none" || childStyle.filter === "none") {
    throw new Error("Nested filter fixture is incomplete.");
  }

  const expectedPositions = new Map([
    [".absolute-chip", "absolute"],
    [".fixed-chip", "fixed"],
    [".sticky-chip", "sticky"]
  ]);
  for (const [selector, expected] of expectedPositions) {
    if (style(selector).position !== expected) throw new Error(`${selector} must use position:${expected}.`);
  }
  const scrollport = required<HTMLElement>(".sticky-scrollport");
  if (scrollport.scrollTop < 50) throw new Error("Sticky fixture was not scrolled into its stuck state.");
  if (getComputedStyle(scrollport).transform === "none") {
    throw new Error("Sticky scrollport must retain a scale/rotate transform stress case.");
  }

  const clipStyle = style(".clip-card");
  if (clipStyle.overflow !== "hidden" || clipStyle.clipPath === "none" || clipStyle.borderRadius === "0px") {
    throw new Error("Overflow, clip-path, and border-radius must be tested together.");
  }
  if (style(".alpha-b").mixBlendMode !== "multiply" || !style(".alpha-a").backgroundColor.includes("0.62")) {
    throw new Error("Transparent and semi-transparent layer fixture is incomplete.");
  }

  const table = required<HTMLTableElement>(".complex-table");
  if (!table.querySelector("[rowspan='3']") || !table.querySelector("[colspan='3']") || !table.querySelector("[colspan='4']")) {
    throw new Error("Complex table must include rowspan and multiple colspan geometries.");
  }
  const hintedColumns = Array.from(table.querySelectorAll<HTMLTableColElement>("colgroup col"));
  const inlineWidthCell = table.querySelector<HTMLTableCellElement>("td[style*='width']");
  if (hintedColumns.length !== 4 || hintedColumns.some((column) => !column.style.width) || !inlineWidthCell?.style.width) {
    throw new Error("Complex table must retain colgroup and inline cell width hints.");
  }
  if (style(".mixed-direction").direction !== "rtl" || style(".rtl-cell").direction !== "rtl") {
    throw new Error("Mixed RTL/Korean/English fixture lost RTL direction.");
  }
  if (style(".raise").verticalAlign !== "super" || style(".sink").verticalAlign !== "sub") {
    throw new Error("Vertical-align sup/sub fixture is incomplete.");
  }
  const pseudoContent = getComputedStyle(required(".counter-list > li"), "::before").content;
  if (!pseudoContent || pseudoContent === "none" || pseudoContent === "normal") {
    throw new Error("CSS counter pseudo-element fixture is inactive.");
  }

  const whitespaceModes = ["normal", "pre", "pre-wrap", "break-spaces"];
  for (const mode of whitespaceModes) {
    if (style(`.whitespace-${mode}`).whiteSpace !== mode) {
      throw new Error(`white-space:${mode} fixture is inactive.`);
    }
  }
  if (Number.parseFloat(style(".font-tiny").fontSize) > 3.1 || Number.parseFloat(style(".font-huge").fontSize) < 71.9) {
    throw new Error("Extreme font-size fixture must cover 3px through 72px.");
  }
  if (style(".gradient-text").getPropertyValue("-webkit-text-fill-color") !== "rgba(0, 0, 0, 0)" ||
      style(".ellipsis-text").textOverflow !== "ellipsis" ||
      style(".line-clamp-text").getPropertyValue("-webkit-line-clamp") !== "2" ||
      style(".emphasis-text").getPropertyValue("-webkit-text-emphasis-style") === "none") {
    throw new Error("Advanced text-paint and overflow fixtures are inactive.");
  }

  if (style(".multicol").columnCount !== "2" || style(".vertical-writing").writingMode !== "vertical-rl") {
    throw new Error("Multi-column and vertical-writing fixtures are inactive.");
  }
  const ruby = required<HTMLElement>(".ruby-case");
  if (!ruby.querySelector("ruby") || !ruby.querySelector("rt")) throw new Error("Ruby annotation fixture is incomplete.");
  const firstLetter = getComputedStyle(required(".first-letter-case"), "::first-letter");
  if (Number.parseFloat(firstLetter.fontSize) < 48 || firstLetter.color === style(".first-letter-case").color) {
    throw new Error("::first-letter fixture is inactive.");
  }
  const firstLetterPunctuationCharacters = assertFirstLetterPunctuationFixture(
    required<HTMLElement>(".first-letter-probe")
  );
  const hiddenFirstLetterPrefix = required<HTMLElement>(".first-letter-hidden");
  if (getComputedStyle(hiddenFirstLetterPrefix).display !== "none" ||
      hiddenFirstLetterPrefix.getAttribute("aria-hidden") !== "true") {
    throw new Error("Hidden first-letter prefix fixture must remain non-rendered and aria-hidden.");
  }
  const generatedBeforeCase = required<HTMLElement>(".first-letter-before-case");
  if (!getComputedStyle(generatedBeforeCase, "::before").content.includes("앞")) {
    throw new Error("Generated ::before first-letter fixture is inactive.");
  }
  const ariaVisibleFirstLetter = required<HTMLElement>(".first-letter-aria-visible");
  if (getComputedStyle(ariaVisibleFirstLetter).display === "none" ||
      ariaVisibleFirstLetter.getAttribute("aria-hidden") !== "true") {
    throw new Error("ARIA-only first-letter fixture must remain visually rendered.");
  }
  const firstLineCase = required<HTMLElement>(".first-line-case");
  assertDeclaredFirstLineFixtureRule();
  const firstLine = getComputedStyle(firstLineCase, "::first-line");
  const reportsFirstLineStyle = firstLine.color !== style(".first-line-case").color &&
    firstLine.textDecorationLine.includes("underline");
  // Native Apple WebKit paints ::first-line correctly but can expose the
  // originating element's values through getComputedStyle(..., "::first-line").
  // Keep the CSSOM declaration check above and the required first-line pixel
  // region below authoritative; only the unsupported introspection is waived.
  if (!reportsFirstLineStyle && !isNativeAppleWebKit()) {
    throw new Error("::first-line fixture is inactive.");
  }
  const details = required<HTMLDetailsElement>(".live-details");
  const textarea = required<HTMLTextAreaElement>(".live-textarea");
  const select = required<HTMLSelectElement>(".live-select");
  if (!details.open || textarea.value !== "라이브 값 1\nlive value 2" || select.selectedIndex !== 2) {
    throw new Error("Live form/control state fixture is inactive.");
  }
  if (style(".contents-wrapper").display !== "contents") throw new Error("display:contents fixture is inactive.");

  const nonuniformPairs = Array.from(document.querySelectorAll<HTMLElement>(".adversarial-slice-pair"));
  if (nonuniformPairs.length < 4) throw new Error("At least four adversarial nonuniform page slices are required.");
  const sliceHeights = nonuniformPairs.map((pair) => {
    const top = Number(pair.dataset.pageTop);
    const bottom = Number(pair.dataset.nonuniformPageBottom);
    const physicalHeight = Number(pair.dataset.pageHeight);
    const slice = getFixedPageSliceLayout(top, bottom, physicalHeight);
    if (slice.blankHeightPx <= 0) throw new Error(`${pair.dataset.case} is not a nonuniform slice.`);
    return slice.contentHeightPx;
  });
  if (new Set(sliceHeights).size < 4) throw new Error("Nonuniform page slices must have distinct heights.");

  return {
    longUnbrokenKoreanCharacters: longKorean.length,
    longUrlCharacters: longUrl.length,
    whitespaceModes,
    nonuniformSliceHeights: sliceHeights,
    fixedStickyAbsolute: Array.from(expectedPositions.values()),
    complexTableSpans: table.querySelectorAll("[rowspan], [colspan]").length,
    firstLetterPunctuationCharacters
  };
}

function assertDeclaredFirstLineFixtureRule(): void {
  const selector = ".first-line-case::first-line";
  let matchingRule: CSSStyleRule | null = null;
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (rule.selectorText.split(",").some((part) => part.trim() === selector)) {
        matchingRule = rule;
        break;
      }
    }
    if (matchingRule) break;
  }
  if (!matchingRule?.style.getPropertyValue("color") ||
      !matchingRule.style.getPropertyValue("font-weight") ||
      matchingRule.style.getPropertyValue("text-decoration-line") !== "underline" ||
      matchingRule.style.getPropertyValue("text-decoration-style") !== "wavy" ||
      !matchingRule.style.getPropertyValue("text-decoration-color")) {
    throw new Error("::first-line fixture CSS rule is missing required paint declarations.");
  }
}

function isNativeAppleWebKit(): boolean {
  const userAgent = navigator.userAgent;
  return navigator.vendor === "Apple Computer, Inc." &&
    userAgent.includes("AppleWebKit/") &&
    !/(?:Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS)\//u.test(userAgent);
}

function getPrimaryRasterScale(): number {
  if (!isNativeAppleWebKit()) return 1;
  const deviceScale = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
  return Math.min(2, Math.max(1, deviceScale));
}

function assertFirstLetterPunctuationFixture(probe: HTMLElement): number {
  const textNode = Array.from(probe.childNodes).find((node): node is Text => node.nodeType === Node.TEXT_NODE);
  if (!textNode?.nodeValue) throw new Error("First-letter punctuation fixture lost its text node.");
  const graphemes = segmentTextGraphemes(textNode.nodeValue);
  const expected = ["(", "[", "“", "첫", "!", "”", "]", ")"];
  if (graphemes.map((segment) => segment.text).join("") !== expected.join("")) {
    throw new Error("First-letter punctuation fixture must contain the exact adversarial sequence.");
  }
  const heights = graphemes.map((segment) => {
    const range = document.createRange();
    range.setStart(textNode, segment.start);
    range.setEnd(textNode, segment.end);
    return range.getBoundingClientRect().height;
  });
  const smallest = Math.min(...heights);
  const largest = Math.max(...heights);
  // WebKit returns zero-sized Range rects for characters represented by
  // ::first-letter even though the rendered pixels and computed pseudo style
  // are correct. The required visual region gate below remains authoritative.
  if (largest < 0.5) return graphemes.length;
  if (smallest < 40 || largest - smallest > 1) {
    throw new Error(
      `Browser ::first-letter must style all associated punctuation; measured heights ${heights.join(", ")}.`
    );
  }
  return graphemes.length;
}

function assertDomWhitespaceRegression(): void {
  const inline = getWhitespaceFixture("inline");
  const inlineSeparatorNode = getDirectWhitespaceTextNode(inline);
  const inlineSeparator = measureRenderedWhitespaceSeparator(inlineSeparatorNode);
  if (!inlineSeparator) throw new Error("Rendered inline whitespace-only DOM node was not measured.");
  const inlineChildren = inline.children;
  const previous = rectToPositionedText(inlineChildren[0].getBoundingClientRect(), "한글");
  const current = rectToPositionedText(inlineChildren[1].getBoundingClientRect(), "선택");
  if (!isRenderedWhitespaceBoundaryCompatible({
    previous,
    separator: inlineSeparator,
    current,
    fontSize: 16,
    sameContainer: true
  })) {
    throw new Error("Rendered inline whitespace boundary was not accepted.");
  }

  const preserved = getWhitespaceFixture("pre-wrap");
  const preservedSeparator = measureRenderedWhitespaceSeparator(getDirectWhitespaceTextNode(preserved));
  if (preservedSeparator?.text !== "   ") {
    throw new Error(`pre-wrap whitespace was not preserved exactly: ${JSON.stringify(preservedSeparator?.text)}`);
  }

  const compact = getWhitespaceFixture("compact");
  if (Array.from(compact.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && /^\s+$/u.test(node.nodeValue ?? ""))) {
    throw new Error("Compact inline fixture unexpectedly contains a DOM whitespace separator.");
  }

  for (const fixtureName of ["flex", "zero-font"] as const) {
    const fixture = getWhitespaceFixture(fixtureName);
    const separatorNode = getDirectWhitespaceTextNode(fixture);
    if (measureRenderedWhitespaceSeparator(separatorNode)) {
      throw new Error(`${fixtureName} CSS-suppressed whitespace must not produce a PDF separator.`);
    }
  }

  const preEdge = getWhitespaceFixture("pre-edge");
  const preChildren = preEdge.children;
  const leadingNode = preEdge.firstChild;
  const trailingNode = preEdge.lastChild;
  if (!(leadingNode instanceof Text) || !(trailingNode instanceof Text) ||
      preChildren.length !== 2 || leadingNode.nodeValue !== "  " || trailingNode.nodeValue !== "   ") {
    throw new Error("Pre edge-whitespace fixture DOM shape regressed.");
  }
  const leading = measureRenderedWhitespaceSeparator(leadingNode);
  const trailing = measureRenderedWhitespaceSeparator(trailingNode);
  if (leading?.text !== "  " || trailing?.text !== "   ") {
    throw new Error("Pre leading/trailing whitespace was not measured exactly.");
  }
  const leadingAdjacent = rectToPositionedText(preChildren[0].getBoundingClientRect(), "code");
  const trailingAdjacent = rectToPositionedText(preChildren[1].getBoundingClientRect(), "끝");
  if (!isRenderedLeadingWhitespaceBoundaryCompatible({
    separator: leading,
    adjacent: leadingAdjacent,
    fontSize: 16,
    sameContainer: true
  }) || !isRenderedTrailingWhitespaceBoundaryCompatible({
    separator: trailing,
    adjacent: trailingAdjacent,
    fontSize: 16,
    sameContainer: true
  })) {
    throw new Error("Pre leading/trailing whitespace edge attachment regressed.");
  }
}

function getWhitespaceFixture(name: string): HTMLElement {
  const fixture = document.querySelector<HTMLElement>(`[data-whitespace-case="${name}"]`);
  if (!fixture) throw new Error(`Missing DOM whitespace fixture: ${name}.`);
  return fixture;
}

function getDirectWhitespaceTextNode(parent: HTMLElement): Text {
  const node = Array.from(parent.childNodes).find(
    (candidate): candidate is Text => candidate.nodeType === Node.TEXT_NODE && /^\s+$/u.test(candidate.nodeValue ?? "")
  );
  if (!node) throw new Error(`Missing whitespace-only text node for ${parent.dataset.whitespaceCase ?? "unknown"}.`);
  return node;
}

function rectToPositionedText(rect: DOMRect, text: string) {
  return { text, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

async function decodePng(bytes: Uint8Array): Promise<HTMLImageElement> {
  const image = document.createElement("img");
  image.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  await image.decode();
  await waitForCanvasDrawableImage(image);
  return image;
}

async function waitForCanvasDrawableImage(image: HTMLImageElement): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Decoded PNG warmup canvas unavailable.");
  for (let frame = 0; frame <= 4; frame += 1) {
    if (frame > 0) await nextFrame();
    context.clearRect(0, 0, 2, 2);
    context.drawImage(image, 0, 0, 2, 2);
    const pixels = context.getImageData(0, 0, 2, 2).data;
    if (pixels.some((value, index) => index % 4 === 3 && value > 0)) {
      image.dataset.canvasWarmupFrames = String(frame);
      return;
    }
  }
  throw new Error("Decoded PNG did not become canvas-drawable after four animation frames.");
}

async function assertGrayscalePng(bytes: Uint8Array): Promise<void> {
  const image = await decodePng(bytes);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Grayscale verification canvas unavailable.");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] !== pixels[offset + 1] || pixels[offset + 1] !== pixels[offset + 2]) {
        throw new Error("Grayscale DOM snapshot contains colored pixels.");
      }
    }
  } finally {
    URL.revokeObjectURL(image.src);
  }
}

async function assertRasterContentMatches(
  baseImage: HTMLImageElement,
  candidateImage: HTMLImageElement,
  label: string,
  onMeasured?: (metrics: RasterComparisonMetrics) => void
): Promise<void> {
  const width = baseImage.naturalWidth;
  const height = baseImage.naturalHeight;
  const baseCanvas = document.createElement("canvas");
  const downscaledCanvas = document.createElement("canvas");
  baseCanvas.width = downscaledCanvas.width = width;
  baseCanvas.height = downscaledCanvas.height = height;
  const baseContext = baseCanvas.getContext("2d");
  const downscaledContext = downscaledCanvas.getContext("2d");
  if (!baseContext || !downscaledContext) throw new Error("2x verification canvas unavailable.");
  baseContext.drawImage(baseImage, 0, 0);
  downscaledContext.imageSmoothingEnabled = true;
  downscaledContext.imageSmoothingQuality = "high";
  downscaledContext.drawImage(candidateImage, 0, 0, width, height);
  const base = baseContext.getImageData(0, 0, width, height).data;
  const downscaled = downscaledContext.getImageData(0, 0, width, height).data;
  const background = [base[0], base[1], base[2]];
  let contentPixels = 0;
  let mismatchedPixels = 0;
  let baseOpaquePixels = 0;
  let candidateOpaquePixels = 0;
  let absoluteError = 0;
  for (let offset = 0; offset < base.length; offset += 4) {
    if (base[offset + 3] > 0) baseOpaquePixels += 1;
    if (downscaled[offset + 3] > 0) candidateOpaquePixels += 1;
    const differsFromBackground = Math.max(
      Math.abs(downscaled[offset] - background[0]),
      Math.abs(downscaled[offset + 1] - background[1]),
      Math.abs(downscaled[offset + 2] - background[2])
    ) > 8 && downscaled[offset + 3] > 0;
    if (differsFromBackground) contentPixels += 1;
    if (Math.max(
      Math.abs(base[offset] - downscaled[offset]),
      Math.abs(base[offset + 1] - downscaled[offset + 1]),
      Math.abs(base[offset + 2] - downscaled[offset + 2])
    ) > 32) mismatchedPixels += 1;
    absoluteError += Math.abs(base[offset] - downscaled[offset]);
    absoluteError += Math.abs(base[offset + 1] - downscaled[offset + 1]);
    absoluteError += Math.abs(base[offset + 2] - downscaled[offset + 2]);
  }
  const totalPixels = Math.max(1, width * height);
  const normalizedError = absoluteError / (totalPixels * 3 * 255);
  const metrics: RasterComparisonMetrics = {
    label,
    width,
    height,
    candidateWidth: candidateImage.naturalWidth,
    candidateHeight: candidateImage.naturalHeight,
    candidateCanvasWarmupFrames: Number(candidateImage.dataset.canvasWarmupFrames ?? 0),
    baseOpaquePixelRatio: baseOpaquePixels / totalPixels,
    candidateOpaquePixelRatio: candidateOpaquePixels / totalPixels,
    contentPixelRatio: contentPixels / totalPixels,
    mismatchedPixelRatio: mismatchedPixels / totalPixels,
    normalizedError
  };
  onMeasured?.(metrics);
  if (metrics.contentPixelRatio < 0.01) throw new Error(`${label} is unexpectedly empty.`);
  if (normalizedError > 0.04) {
    throw new Error(`${label} diverged from 1x (${(normalizedError * 100).toFixed(3)}%).`);
  }
}

function recordRasterArtifacts(
  oneXBytes: Uint8Array,
  twoXBytes: Uint8Array,
  metrics: RasterComparisonMetrics
): void {
  (window as RasterDiagnosticWindow).__mobilePdfRasterArtifacts = {
    oneXPngBase64: encodeBase64(oneXBytes),
    twoXPngBase64: encodeBase64(twoXBytes),
    metrics
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function withSafariUserAgent<T>(action: () => Promise<T>): Promise<T> {
  const navigatorObject = window.navigator as Navigator & { userAgent: string };
  const ownDescriptor = Object.getOwnPropertyDescriptor(navigatorObject, "userAgent");
  Object.defineProperty(navigatorObject, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });
  try {
    return await action();
  } finally {
    if (ownDescriptor) Object.defineProperty(navigatorObject, "userAgent", ownDescriptor);
    else delete (navigatorObject as Navigator & { userAgent?: string }).userAgent;
  }
}

function collectFeatureRegions(
  source: HTMLElement,
  sourceRect: DOMRect,
  referenceRect: DOMRect,
  snapshotRect: DOMRect,
  pageTopPx: number,
  pageHeightPx: number
): RegionRecord[] {
  const selectors = [
    ["mark", "mark"],
    ["del", "del"],
    ["code", "code"],
    ["table", "table"],
    ["complex-table", ".complex-table"],
    ["callout", ".callout"],
    ["blockquote", "blockquote"],
    ["input", "input"],
    ["pre", "pre"],
    ["svg", "svg"],
    ["canvas", "canvas"],
    ["image", "img"],
    ["badge", ".badge"],
    ["long-unbroken", ".long-unbroken"],
    ["long-url", ".long-url"],
    ["negative-tight", ".negative-tight"],
    ["mixed-direction", ".mixed-direction"],
    ["vertical-stack", ".vertical-stack"],
    ["font-tiny", ".font-tiny"],
    ["font-huge", ".font-huge"],
    ["whitespace-normal", ".whitespace-normal"],
    ["whitespace-pre", ".whitespace-pre"],
    ["whitespace-pre-wrap", ".whitespace-pre-wrap"],
    ["whitespace-break-spaces", ".whitespace-break-spaces"],
    ["counter-list", ".counter-list"],
    ["gradient-text", ".gradient-text"],
    ["stroke-text", ".stroke-text"],
    ["ellipsis-text", ".ellipsis-text"],
    ["line-clamp-text", ".line-clamp-text"],
    ["emphasis-text", ".emphasis-text"],
    ["transform-root", ".transform-root"],
    ["transform-middle", ".transform-middle"],
    ["transform-child", ".transform-child"],
    ["position-stage", ".position-stage"],
    ["absolute-chip", ".absolute-chip"],
    ["fixed-chip", ".fixed-chip"],
    ["sticky-scrollport", ".sticky-scrollport"],
    ["sticky-chip", ".sticky-chip"],
    ["clip-card", ".clip-card"],
    ["alpha-stack", ".alpha-stack"],
    ["alpha-layer", ".alpha-stack > span"],
    ["multicol", ".multicol"],
    ["vertical-writing", ".vertical-writing"],
    ["ruby", ".ruby-case"],
    ["first-letter", ".first-letter-case"],
    ["first-letter-probe", ".first-letter-probe"],
    ["first-letter-before", ".first-letter-before-case"],
    ["first-letter-aria", ".first-letter-aria-case"],
    ["first-line", ".first-line-case"],
    ["live-state", ".live-state-grid"],
    ["details", ".live-details"],
    ["textarea", ".live-textarea"],
    ["select", ".live-select"],
    ["display-contents-child", ".contents-wrapper > span"],
    ["page-stress-band", ".page-stress-band"],
    ["boundary-crossing-line", ".boundary-crossing-line"]
  ] as const;
  const regions: RegionRecord[] = [];
  for (const [feature, selector] of selectors) {
    for (const [index, element] of Array.from(source.querySelectorAll<HTMLElement | SVGElement>(selector)).entries()) {
      const rect = element.getBoundingClientRect();
      const localLeft = rect.left - sourceRect.left;
      const localTop = rect.top - sourceRect.top - pageTopPx;
      const visibleLeft = Math.max(0, localLeft);
      const visibleTop = Math.max(0, localTop);
      const visibleRight = Math.min(sourceRect.width, localLeft + rect.width);
      const visibleBottom = Math.min(pageHeightPx, localTop + rect.height);
      if (visibleRight - visibleLeft < 2 || visibleBottom - visibleTop < 2) continue;
      const width = visibleRight - visibleLeft;
      const height = visibleBottom - visibleTop;
      regions.push({
        id: `${feature}:${index}`,
        source: roundValues(referenceRect.left + visibleLeft, referenceRect.top + visibleTop, width, height),
        snapshot: roundValues(snapshotRect.left + visibleLeft, snapshotRect.top + visibleTop, width, height)
      });
    }
  }
  for (const [feature, selector] of [
    ["absolute-chip-core", ".absolute-chip"],
    ["fixed-chip-core", ".fixed-chip"]
  ] as const) {
    const element = source.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    // The center and right side contain antialiased text whose generic-font
    // width varies in foreignObject on WebKit. Sample the solid left padding,
    // far enough inside the rounded edge even for the rotated absolute chip.
    // A position or background-color regression still moves/recolors all 16
    // sampled pixels.
    const width = 4;
    const height = 4;
    const localLeft = rect.left - sourceRect.left + 6;
    const localTop = rect.top - sourceRect.top - pageTopPx + (rect.height - height) / 2;
    if (localLeft >= 0 && localTop >= 0 && localLeft + width <= sourceRect.width && localTop + height <= pageHeightPx) {
      regions.push({
        id: `${feature}:0`,
        source: roundValues(referenceRect.left + localLeft, referenceRect.top + localTop, width, height),
        snapshot: roundValues(snapshotRect.left + localLeft, snapshotRect.top + localTop, width, height)
      });
    }
  }
  const firstLetter = source.querySelector<HTMLElement>(".first-letter-case");
  const firstLetterRect = firstLetter ? getFirstRenderedCharacterRect(firstLetter) : null;
  if (firstLetterRect) {
    const localLeft = firstLetterRect.left - sourceRect.left;
    const localTop = firstLetterRect.top - sourceRect.top - pageTopPx;
    const visibleLeft = Math.max(0, localLeft);
    const visibleTop = Math.max(0, localTop);
    const visibleRight = Math.min(sourceRect.width, localLeft + firstLetterRect.width);
    const visibleBottom = Math.min(pageHeightPx, localTop + firstLetterRect.height);
    if (visibleRight - visibleLeft >= 2 && visibleBottom - visibleTop >= 2) {
      const width = visibleRight - visibleLeft;
      const height = visibleBottom - visibleTop;
      regions.push({
        id: "first-letter-glyph:0",
        source: roundValues(referenceRect.left + visibleLeft, referenceRect.top + visibleTop, width, height),
        snapshot: roundValues(snapshotRect.left + visibleLeft, snapshotRect.top + visibleTop, width, height)
      });
    }
  }
  if (!regions.some((region) => region.id === "first-letter-probe:0")) {
    const probe = source.querySelector<HTMLElement>(".first-letter-probe");
    const parent = source.querySelector<HTMLElement>(".first-letter-case");
    if (probe && parent) {
      const textNode = Array.from(probe.childNodes).find((node): node is Text => node.nodeType === Node.TEXT_NODE);
      let rect: DOMRect | null = null;
      if (textNode?.nodeValue) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const measured = range.getBoundingClientRect();
        if (measured.width >= 2 && measured.height >= 2) rect = measured;
      }
      if (!rect) {
        const parentRect = parent.getBoundingClientRect();
        rect = new DOMRect(parentRect.left, parentRect.top, Math.min(235, parentRect.width), parentRect.height);
      }
      const localLeft = rect.left - sourceRect.left;
      const localTop = rect.top - sourceRect.top - pageTopPx;
      const visibleLeft = Math.max(0, localLeft);
      const visibleTop = Math.max(0, localTop);
      const visibleRight = Math.min(sourceRect.width, localLeft + rect.width);
      const visibleBottom = Math.min(pageHeightPx, localTop + rect.height);
      if (visibleRight - visibleLeft >= 2 && visibleBottom - visibleTop >= 2) {
        regions.push({
          id: "first-letter-probe:0",
          source: roundValues(
            referenceRect.left + visibleLeft,
            referenceRect.top + visibleTop,
            visibleRight - visibleLeft,
            visibleBottom - visibleTop
          ),
          snapshot: roundValues(
            snapshotRect.left + visibleLeft,
            snapshotRect.top + visibleTop,
            visibleRight - visibleLeft,
            visibleBottom - visibleTop
          )
        });
      }
    }
  }
  const beforeCase = source.querySelector<HTMLElement>(".first-letter-before-case");
  if (beforeCase) {
    const rect = beforeCase.getBoundingClientRect();
    const localLeft = rect.left - sourceRect.left;
    const localTop = rect.top - sourceRect.top - pageTopPx;
    const visibleLeft = Math.max(0, localLeft);
    const visibleTop = Math.max(0, localTop);
    const visibleRight = Math.min(sourceRect.width, localLeft + Math.min(112, rect.width));
    const visibleBottom = Math.min(pageHeightPx, localTop + rect.height);
    if (visibleRight - visibleLeft >= 2 && visibleBottom - visibleTop >= 2) {
      regions.push({
        id: "first-letter-before-glyph:0",
        source: roundValues(
          referenceRect.left + visibleLeft,
          referenceRect.top + visibleTop,
          visibleRight - visibleLeft,
          visibleBottom - visibleTop
        ),
        snapshot: roundValues(
          snapshotRect.left + visibleLeft,
          snapshotRect.top + visibleTop,
          visibleRight - visibleLeft,
          visibleBottom - visibleTop
        )
      });
    }
  }
  return regions;
}

function getFirstRenderedCharacterRect(element: HTMLElement): DOMRect | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    const value = textNode.nodeValue ?? "";
    const firstNonWhitespace = value.search(/\S/u);
    if (firstNonWhitespace >= 0) {
      const range = document.createRange();
      range.setStart(textNode, firstNonWhitespace);
      range.setEnd(textNode, firstNonWhitespace + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width >= 0.5 && rect.height >= 0.5) return rect;
    }
    textNode = walker.nextNode() as Text | null;
  }
  return null;
}

function paintFixtureCanvases(): void {
  for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>(".fixture canvas"))) {
    const context = canvas.getContext("2d");
    if (!context) continue;
    const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, "#ff6b6b");
    gradient.addColorStop(0.5, "#ffd43b");
    gradient.addColorStop(1, "#20c997");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(20, 25, 35, .72)";
    context.font = "700 31px -apple-system, sans-serif";
    context.fillText("Canvas 한글", 24, 78);
  }
}

function roundRect(rect: DOMRect): RectRecord {
  return roundValues(rect.x, rect.y, rect.width, rect.height);
}

function roundValues(x: number, y: number, width: number, height: number): RectRecord {
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const rasterComparison = (window as RasterDiagnosticWindow).__mobilePdfRasterArtifacts?.metrics ?? null;
  const resultNode = document.createElement("script");
  resultNode.id = "render-fidelity-results";
  resultNode.type = "application/json";
  resultNode.textContent = JSON.stringify({
    ok: false,
    error: stack ? `${message}\n${stack}` : message,
    errorMessage: message,
    errorStack: stack,
    rasterComparison
  });
  document.body.appendChild(resultNode);
  document.documentElement.dataset.testReady = "true";
});
