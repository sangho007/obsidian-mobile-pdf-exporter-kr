export interface GraphemeSegment {
  text: string;
  start: number;
  end: number;
}

export interface TextMergeGeometry {
  previousTop: number;
  previousRight: number;
  previousFontSize: number;
  currentTop: number;
  currentLeft: number;
  currentFontSize: number;
  sameContainer: boolean;
}

export interface PositionedText {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RenderedWhitespaceBoundary {
  previous: PositionedText;
  separator: PositionedText;
  current: PositionedText;
  fontSize: number;
  sameContainer: boolean;
}

export interface RenderedEdgeWhitespaceBoundary {
  separator: PositionedText;
  adjacent: PositionedText;
  fontSize: number;
  sameContainer: boolean;
}

export interface FixedPageSliceLayout {
  contentHeightPx: number;
  blankHeightPx: number;
}

export interface PageBreakBlock {
  top: number;
  bottom: number;
  priority: number;
}

export interface PageBreakOptions {
  paddingPx?: number;
  minimumAdvancePx?: number;
  textPriority?: number;
}

const DEFAULT_PAGE_BREAK_PADDING_PX = 8;
const DEFAULT_PAGE_BREAK_MINIMUM_ADVANCE_PX = 72;
const DEFAULT_TEXT_BLOCK_PRIORITY = 1;
const SNAPSHOT_GEOMETRY_PRECISION = 1_000;
const MAX_COMPUTED_PAGE_COUNT = 4_096;

export function startsInsidePageBreakInterval(
  fragmentTopPx: number,
  pageTopPx: number,
  candidateBreakPx: number,
  minimumAdvancePx: number,
  paddingPx: number
): boolean {
  return Number.isFinite(fragmentTopPx) && Number.isFinite(pageTopPx) &&
    Number.isFinite(candidateBreakPx) &&
    fragmentTopPx > pageTopPx + Math.max(0, minimumAdvancePx) &&
    fragmentTopPx < candidateBreakPx - Math.max(0, paddingPx);
}

export function clampPageBreakToPhysicalPage(
  pageTopPx: number,
  candidateBreakPx: number,
  physicalPageHeightPx: number
): number {
  if (!Number.isFinite(pageTopPx) || pageTopPx < 0 ||
      !Number.isFinite(candidateBreakPx) ||
      !Number.isFinite(physicalPageHeightPx) || physicalPageHeightPx <= 0) {
    throw new RangeError("Page break geometry must be finite and the physical height must be positive.");
  }
  return Math.max(pageTopPx, Math.min(candidateBreakPx, pageTopPx + physicalPageHeightPx));
}

/**
 * Maps a possibly short pagination interval onto a fixed-height physical page.
 * The interval is painted at the top; the unused tail remains blank.
 */
export function getFixedPageSliceLayout(
  pageTopPx: number,
  pageBottomPx: number,
  physicalPageHeightPx: number
): FixedPageSliceLayout {
  if (!Number.isFinite(pageTopPx) || pageTopPx < 0) {
    throw new RangeError("Page slice top must be a finite, non-negative number.");
  }
  if (!Number.isFinite(pageBottomPx) || pageBottomPx <= pageTopPx) {
    throw new RangeError("Page slice bottom must be greater than its top.");
  }
  if (!Number.isFinite(physicalPageHeightPx) || physicalPageHeightPx <= 0) {
    throw new RangeError("Physical page height must be a finite, positive number.");
  }

  const contentHeightPx = Math.min(physicalPageHeightPx, pageBottomPx - pageTopPx);
  return {
    contentHeightPx,
    blankHeightPx: Math.max(0, physicalPageHeightPx - contentHeightPx)
  };
}

/**
 * Computes contiguous document slices which never exceed one physical page.
 *
 * Block-level moves preserve media and containers where practical. A final,
 * text-only pass then moves any ordinary line which geometrically crosses the
 * proposed boundary to the following page. That last pass deliberately uses
 * no visual padding: padding can move a boundary into the preceding line when
 * line rectangles touch.
 */
export function computePageBreaks(
  contentHeightPx: number,
  pageHeightPx: number,
  keepBlocks: PageBreakBlock[],
  options: PageBreakOptions = {}
): number[] {
  if (!Number.isFinite(contentHeightPx) || contentHeightPx < 0) {
    throw new RangeError("Content height must be a finite, non-negative number.");
  }
  if (!Number.isFinite(pageHeightPx) || pageHeightPx <= 0) {
    throw new RangeError("Physical page height must be a finite, positive number.");
  }
  if (contentHeightPx === 0) return [0];
  const minimumPageCount = Math.ceil(contentHeightPx / pageHeightPx);
  if (!Number.isFinite(minimumPageCount) || minimumPageCount > MAX_COMPUTED_PAGE_COUNT) {
    throw new RangeError(`Document requires more than ${MAX_COMPUTED_PAGE_COUNT} physical pages.`);
  }

  const paddingPx = finiteNonNegativeOption(options.paddingPx, DEFAULT_PAGE_BREAK_PADDING_PX);
  const minimumAdvancePx = finiteNonNegativeOption(
    options.minimumAdvancePx,
    DEFAULT_PAGE_BREAK_MINIMUM_ADVANCE_PX
  );
  const textPriority = Number.isFinite(options.textPriority)
    ? Number(options.textPriority)
    : DEFAULT_TEXT_BLOCK_PRIORITY;
  const sortedBlocks = keepBlocks
    .filter(isUsablePageBreakBlock)
    .sort((left, right) => left.top - right.top || right.priority - left.priority);
  const breaks = [0];
  let pageTop = 0;

  while (pageTop < contentHeightPx) {
    const physicalBreak = Math.min(contentHeightPx, pageTop + pageHeightPx);
    if (!(physicalBreak > pageTop)) {
      throw new RangeError("Physical page height is too small to advance at this document coordinate.");
    }
    if (physicalBreak >= contentHeightPx) {
      breaks.push(contentHeightPx);
      if (breaks.length - 1 > MAX_COMPUTED_PAGE_COUNT) {
        throw new RangeError(`Pagination produced more than ${MAX_COMPUTED_PAGE_COUNT} pages.`);
      }
      break;
    }

    let nextBreak = physicalBreak;
    const nearbyGapBreak = findNearbyGapBreak(
      pageTop,
      nextBreak,
      pageHeightPx,
      sortedBlocks,
      paddingPx
    );
    if (nearbyGapBreak !== null) nextBreak = nearbyGapBreak;

    const mediaBreak = sortedBlocks
      .filter((fragment) => {
        if (fragment.priority === textPriority) return false;
        if (fragment.priority < 6) return false;
        const height = fragment.bottom - fragment.top;
        const startsOnThisPage = startsInsidePageBreakInterval(
          fragment.top,
          pageTop,
          nextBreak,
          minimumAdvancePx,
          paddingPx
        );
        const crossesBreak = fragment.bottom > nextBreak - paddingPx;
        const remainingHeight = Math.max(0, nextBreak - fragment.top);
        const preferredHeight = Math.min(height, pageHeightPx * 0.92);
        const candidate = fragment.top - paddingPx;
        return startsOnThisPage && crossesBreak &&
          remainingHeight < preferredHeight * 0.88 &&
          candidate > pageTop + pageHeightPx * 0.15;
      })
      .sort((left, right) => left.top - right.top)[0];

    if (mediaBreak) nextBreak = mediaBreak.top - paddingPx;

    const crossing = sortedBlocks
      .filter((fragment) => {
        if (fragment.priority === textPriority) return false;
        const height = fragment.bottom - fragment.top;
        const startsOnThisPage = fragment.top > pageTop + minimumAdvancePx;
        const fitsOnOnePage = height < pageHeightPx * 0.96;
        const crossesBreak = fragment.top < nextBreak && fragment.bottom > nextBreak;
        const candidate = fragment.top - paddingPx;
        return startsOnThisPage && fitsOnOnePage && crossesBreak &&
          candidate > pageTop + pageHeightPx * 0.22;
      })
      .sort((left, right) => right.priority - left.priority || left.top - right.top)[0];

    if (crossing) nextBreak = crossing.top - paddingPx;

    if (nextBreak <= pageTop + minimumAdvancePx) nextBreak = physicalBreak;
    nextBreak = clampPageBreakToPhysicalPage(pageTop, nextBreak, pageHeightPx);

    const safeBreak = retreatBreakBeforeCrossingText(
      pageTop,
      nextBreak,
      pageHeightPx,
      sortedBlocks,
      textPriority,
      minimumAdvancePx,
      nextBreak === physicalBreak ? physicalBreak : null
    );
    if (safeBreak !== null) {
      nextBreak = safeBreak;
    } else if (nextBreak !== physicalBreak) {
      nextBreak = retreatBreakBeforeCrossingText(
        pageTop,
        physicalBreak,
        pageHeightPx,
        sortedBlocks,
        textPriority,
        minimumAdvancePx,
        physicalBreak
      ) ?? physicalBreak;
    } else {
      nextBreak = physicalBreak;
    }

    if (!(nextBreak > pageTop)) nextBreak = physicalBreak;
    nextBreak = Math.min(contentHeightPx, pageTop + pageHeightPx, nextBreak);
    breaks.push(nextBreak);
    if (breaks.length - 1 > MAX_COMPUTED_PAGE_COUNT) {
      throw new RangeError(`Pagination produced more than ${MAX_COMPUTED_PAGE_COUNT} pages.`);
    }
    pageTop = nextBreak;
  }

  return breaks;
}

function findNearbyGapBreak(
  pageTop: number,
  idealBreak: number,
  pageHeightPx: number,
  keepBlocks: PageBreakBlock[],
  paddingPx: number
): number | null {
  const minBreak = pageTop + pageHeightPx * 0.58;
  const maxBreak = pageTop + pageHeightPx * 0.98;
  const candidateBlocks = keepBlocks
    .filter((block) => block.priority >= 2 && block.bottom > pageTop && block.top < idealBreak + pageHeightPx * 0.2)
    .sort((left, right) => left.top - right.top);
  let best: { y: number; score: number } | null = null;

  for (let index = 0; index < candidateBlocks.length - 1; index += 1) {
    const current = candidateBlocks[index];
    const next = candidateBlocks[index + 1];
    const gapTop = current.bottom + paddingPx;
    const gapBottom = next.top - paddingPx;
    if (gapBottom <= gapTop) continue;
    if (gapTop < minBreak || gapTop > maxBreak) continue;

    const y = Math.min(Math.max(gapTop, minBreak), maxBreak);
    const score = Math.abs(idealBreak - y) - Math.min(64, gapBottom - gapTop) * 0.4;
    if (!best || score < best.score) best = { y, score };
  }

  return best?.y ?? null;
}

function retreatBreakBeforeCrossingText(
  pageTop: number,
  candidateBreak: number,
  pageHeightPx: number,
  keepBlocks: PageBreakBlock[],
  textPriority: number,
  minimumAdvancePx: number,
  unavoidableReferenceBreak: number | null
): number | null {
  let safeBreak = candidateBreak;
  let retreatedForText = false;
  const minimumProgress = Math.max(
    1 / SNAPSHOT_GEOMETRY_PRECISION,
    Math.min(minimumAdvancePx, pageHeightPx * 0.15)
  );

  // Blocks are sorted by top. Walking backwards lets one pass find the full
  // overlapping interval chain which contains the candidate boundary.
  for (let index = keepBlocks.length - 1; index >= 0; index -= 1) {
    const fragment = keepBlocks[index];
    if (fragment.priority !== textPriority) continue;
    const height = fragment.bottom - fragment.top;
    if (height > pageHeightPx) continue;
    if (!(fragment.top < safeBreak && fragment.bottom > safeBreak)) continue;

    const retreatedBreak = floorSnapshotCoordinate(fragment.top);
    if (!(retreatedBreak > pageTop + minimumProgress)) {
      const wasAlreadyCrossingReference = unavoidableReferenceBreak !== null &&
        fragment.top < unavoidableReferenceBreak && fragment.bottom > unavoidableReferenceBreak;
      if (!retreatedForText || !wasAlreadyCrossingReference) return null;
      continue;
    }
    safeBreak = retreatedBreak;
    retreatedForText = true;
  }

  return safeBreak;
}

function floorSnapshotCoordinate(value: number): number {
  const scaled = value * SNAPSHOT_GEOMETRY_PRECISION;
  return Number.isFinite(scaled)
    ? Math.floor(scaled) / SNAPSHOT_GEOMETRY_PRECISION
    : value;
}

function isUsablePageBreakBlock(block: PageBreakBlock): boolean {
  return Number.isFinite(block.top) && Number.isFinite(block.bottom) &&
    Number.isFinite(block.priority) && block.bottom > block.top;
}

function finiteNonNegativeOption(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : fallback;
}

export function measureRenderedWhitespaceSeparator(textNode: Text): PositionedText | null {
  const text = textNode.nodeValue ?? "";
  if (!text || !/^\s+$/u.test(text)) return null;
  const parent = textNode.parentElement;
  const style = parent
    ? textNode.ownerDocument.defaultView?.getComputedStyle(parent)
    : null;
  const renderedText = normalizeRenderedWhitespaceText(
    text,
    style?.whiteSpace ?? "normal",
    style?.getPropertyValue("tab-size") ?? "8"
  );
  if (!renderedText) return null;

  const range = textNode.ownerDocument.createRange();
  try {
    range.selectNodeContents(textNode);
    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0.1 && rect.height > 0.1);
    if (rects.length !== 1) return null;
    const rect = rects[0];
    return {
      text: renderedText,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom
    };
  } finally {
    range.detach();
  }
}

export function normalizeRenderedWhitespaceText(
  text: string,
  whiteSpace: string,
  tabSize: string | number = 8
): string | null {
  if (!text || !/^\s+$/u.test(text)) return null;
  const normalized = text.replace(/\r\n?/gu, "\n");
  const mode = whiteSpace.trim().toLowerCase();
  const classicCollapseMode: Record<string, string> = {
    normal: "collapse",
    nowrap: "collapse",
    pre: "preserve",
    "pre-wrap": "preserve",
    "pre-line": "preserve-breaks"
  };
  const collapseMode = classicCollapseMode[mode] ?? mode.split(/\s+/u).find((token) =>
    ["collapse", "preserve", "preserve-breaks", "preserve-spaces", "break-spaces"].includes(token)
  ) ?? "collapse";
  const preservesSpaces = ["preserve", "preserve-spaces", "break-spaces"].includes(collapseMode);
  const preservesLineBreaks = ["preserve", "preserve-breaks", "break-spaces"].includes(collapseMode);

  if (preservesLineBreaks && normalized.includes("\n")) return null;
  if (collapseMode === "preserve-spaces") {
    return normalized.replace(/[\t\n\f\v]/gu, " ") || null;
  }
  if (!preservesSpaces) {
    return normalized.replace(/[ \t\n\f\v]+/gu, " ");
  }
  const rawTabSize = typeof tabSize === "number" ? String(tabSize) : tabSize.trim();
  const parsedTabSize = /^\d+(?:\.\d+)?$/u.test(rawTabSize) ? Number(rawTabSize) : 8;
  const finiteTabSize = Number.isFinite(parsedTabSize) ? parsedTabSize : 8;
  const tabColumns = finiteTabSize === 0
    ? 0
    : Math.max(1, Math.min(16, Math.round(finiteTabSize)));
  const expanded = normalized
    .replace(/\t/gu, " ".repeat(tabColumns))
    .replace(/[\f\v]/gu, " ");
  return expanded || null;
}

export function isRenderedWhitespaceBoundaryCompatible(boundary: RenderedWhitespaceBoundary): boolean {
  const { previous, separator, current } = boundary;
  const horizontalTolerance = Math.max(1, boundary.fontSize * 0.35);
  const previousOverlap = Math.min(previous.bottom, separator.bottom) - Math.max(previous.top, separator.top);
  const currentOverlap = Math.min(current.bottom, separator.bottom) - Math.max(current.top, separator.top);

  return boundary.sameContainer &&
    separator.right - separator.left > 0.1 &&
    previousOverlap > 0.1 &&
    currentOverlap > 0.1 &&
    separator.left >= previous.right - horizontalTolerance &&
    separator.right <= current.left + horizontalTolerance;
}

export function isRenderedLeadingWhitespaceBoundaryCompatible(
  boundary: RenderedEdgeWhitespaceBoundary
): boolean {
  const { separator, adjacent } = boundary;
  const tolerance = Math.max(1, boundary.fontSize * 0.35);
  const verticalOverlap = Math.min(adjacent.bottom, separator.bottom) - Math.max(adjacent.top, separator.top);
  return boundary.sameContainer &&
    separator.right - separator.left > 0.1 &&
    verticalOverlap > 0.1 &&
    separator.left <= adjacent.left + tolerance &&
    Math.abs(adjacent.left - separator.right) <= tolerance;
}

export function isRenderedTrailingWhitespaceBoundaryCompatible(
  boundary: RenderedEdgeWhitespaceBoundary
): boolean {
  const { separator, adjacent } = boundary;
  const tolerance = Math.max(1, boundary.fontSize * 0.35);
  const verticalOverlap = Math.min(adjacent.bottom, separator.bottom) - Math.max(adjacent.top, separator.top);
  return boundary.sameContainer &&
    separator.right - separator.left > 0.1 &&
    verticalOverlap > 0.1 &&
    separator.right >= adjacent.right - tolerance &&
    Math.abs(separator.left - adjacent.right) <= tolerance;
}

export function segmentTextGraphemes(text: string): GraphemeSegment[] {
  type SegmentRecord = { segment: string; index: number };
  type SegmenterInstance = { segment(value: string): Iterable<SegmentRecord> };
  type SegmenterConstructor = new (
    locales?: string | string[],
    options?: { granularity: "grapheme" }
  ) => SegmenterInstance;
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (Segmenter) {
    const segments = Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text));
    return segments.map((segment, index) => ({
      text: segment.segment,
      start: segment.index,
      end: segments[index + 1]?.index ?? text.length
    }));
  }

  return segmentTextGraphemesFallback(text);
}

export function segmentTextGraphemesFallback(text: string): GraphemeSegment[] {
  const segments: GraphemeSegment[] = [];
  let offset = 0;
  let regionalIndicatorCount = 0;
  for (const char of Array.from(text)) {
    const start = offset;
    offset += char.length;
    const previous = segments[segments.length - 1];
    const append = previous && shouldAppendFallbackGrapheme(previous.text, char, regionalIndicatorCount);
    if (append) {
      previous.text += char;
      previous.end = offset;
    } else {
      segments.push({ text: char, start, end: offset });
    }
    regionalIndicatorCount = isRegionalIndicator(char)
      ? (append ? regionalIndicatorCount + 1 : 1)
      : 0;
  }
  return segments;
}

function shouldAppendFallbackGrapheme(previous: string, current: string, regionalIndicatorCount: number): boolean {
  if (previous === "\r" && current === "\n") return true;
  if (/^[\p{Mark}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u{1F3FB}-\u{1F3FF}]$/u.test(current)) return true;
  if (current === "\u200D" || previous.endsWith("\u200D")) return true;
  const previousCharacters = Array.from(previous);
  const previousHangul = hangulGraphemeClass(previousCharacters[previousCharacters.length - 1] ?? "");
  const currentHangul = hangulGraphemeClass(current);
  if (previousHangul === "L" && ["L", "V", "LV", "LVT"].includes(currentHangul)) return true;
  if (["LV", "V"].includes(previousHangul) && ["V", "T"].includes(currentHangul)) return true;
  if (["LVT", "T"].includes(previousHangul) && currentHangul === "T") return true;
  return isRegionalIndicator(current) && regionalIndicatorCount % 2 === 1;
}

function hangulGraphemeClass(value: string): "L" | "V" | "T" | "LV" | "LVT" | "other" {
  const codePoint = value.codePointAt(0) ?? -1;
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0xa960 && codePoint <= 0xa97c)) return "L";
  if ((codePoint >= 0x1160 && codePoint <= 0x11a7) || (codePoint >= 0xd7b0 && codePoint <= 0xd7c6)) return "V";
  if ((codePoint >= 0x11a8 && codePoint <= 0x11ff) || (codePoint >= 0xd7cb && codePoint <= 0xd7fb)) return "T";
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return (codePoint - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return "other";
}

function isRegionalIndicator(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? -1;
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

export function verticalCenterBelongsToPage(
  top: number,
  bottom: number,
  pageTop: number,
  pageBottom: number
): boolean {
  const center = (top + bottom) / 2;
  return center >= pageTop && center < pageBottom;
}

export function fitTextSizeToWidth(size: number, measuredWidth: number, availableWidth: number): number {
  if (!Number.isFinite(size) || size <= 0) return 1;
  if (!Number.isFinite(measuredWidth) || measuredWidth <= 0) return size;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  return measuredWidth > availableWidth
    ? Math.max(1, size * (availableWidth / measuredWidth))
    : size;
}

export function isTextMergeGeometryCompatible(geometry: TextMergeGeometry): boolean {
  const gap = geometry.currentLeft - geometry.previousRight;
  return geometry.sameContainer &&
    Math.abs(geometry.previousTop - geometry.currentTop) <= Math.max(2.5, geometry.currentFontSize * 0.35) &&
    geometry.currentLeft >= geometry.previousRight - geometry.currentFontSize * 0.5 &&
    gap <= Math.max(2, geometry.currentFontSize * 0.75) &&
    Math.abs(geometry.previousFontSize - geometry.currentFontSize) <= 0.15;
}

export function buildEncodablePositionedRuns(
  graphemes: PositionedText[],
  fontSize: number,
  encode: (text: string) => string
): PositionedText[] {
  const runs: PositionedText[] = [];
  let current: PositionedText | null = null;
  const pushCurrent = (): void => {
    if (current && current.text.trim()) runs.push(current);
    current = null;
  };

  for (const grapheme of graphemes) {
    const clean = encode(grapheme.text);
    if (!clean) {
      pushCurrent();
      continue;
    }

    const sameRun = current &&
      Math.abs(current.top - grapheme.top) <= Math.max(2.5, fontSize * 0.35) &&
      grapheme.left >= current.right - fontSize * 0.5 &&
      grapheme.left - current.right <= Math.max(2, fontSize * 0.75);
    if (!sameRun) pushCurrent();
    if (!current) current = { ...grapheme, text: "" };
    current.text += clean;
    current.left = Math.min(current.left, grapheme.left);
    current.top = Math.min(current.top, grapheme.top);
    current.right = Math.max(current.right, grapheme.right);
    current.bottom = Math.max(current.bottom, grapheme.bottom);
  }
  pushCurrent();
  return runs;
}
