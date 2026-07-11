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
