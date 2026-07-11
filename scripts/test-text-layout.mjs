#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const helperDir = mkdtempSync(`${tmpdir()}/mobile-pdf-text-layout-`);
const bundlePath = resolve(helperDir, "text-layout.mjs");

try {
  await build({
    entryPoints: [resolve("src/text-layout.ts")],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    platform: "node",
    target: "es2021",
    logLevel: "silent"
  });
  const layout = await import(pathToFileURL(bundlePath).href);

  const nonuniformBreaks = [0, 640, 1015];
  const nonuniformPages = nonuniformBreaks.slice(0, -1).map((pageTopPx, index) =>
    layout.getFixedPageSliceLayout(pageTopPx, nonuniformBreaks[index + 1], 1000)
  );
  assert.deepEqual(nonuniformPages, [
    { contentHeightPx: 640, blankHeightPx: 360 },
    { contentHeightPx: 375, blankHeightPx: 625 }
  ], "short/nonuniform intervals must render consecutively at the top of fixed-height pages");
  const fullPage = layout.getFixedPageSliceLayout(0, 1000, 1000);
  assert.deepEqual(fullPage, {
    contentHeightPx: 1000,
    blankHeightPx: 0
  }, "a uniform interval must continue to fill the physical page");
  assert.equal(
    layout.startsInsidePageBreakInterval(900, 0, 1000, 72, 8),
    true,
    "a media block starting near the current page end may move that page break earlier"
  );
  assert.equal(
    layout.startsInsidePageBreakInterval(2000, 0, 1000, 72, 8),
    false,
    "media on a future page must never move the current page break past its physical height"
  );
  assert.equal(
    layout.clampPageBreakToPhysicalPage(0, 1992, 1000),
    1000,
    "every computed break must stay within one physical page of its predecessor"
  );

  const graphemes = layout.segmentTextGraphemes("가가ᄒᆞᆫ글👨‍👩‍👧‍👦").map((item) => item.text);
  assert.deepEqual(graphemes, ["가", "가", "ᄒᆞᆫ", "글", "👨‍👩‍👧‍👦"]);
  const fallbackGraphemes = layout.segmentTextGraphemesFallback("가가ᄒᆞᆫ글👨‍👩‍👧‍👦").map((item) => item.text);
  assert.deepEqual(fallbackGraphemes, ["가", "가", "ᄒᆞᆫ", "글", "👨‍👩‍👧‍👦"]);

  const firstPage = layout.verticalCenterBelongsToPage(90, 110, 0, 100);
  const secondPage = layout.verticalCenterBelongsToPage(90, 110, 100, 200);
  assert.equal(Number(firstPage) + Number(secondPage), 1, "a line crossing a page break must belong to exactly one page");
  assert.equal(firstPage, false);
  assert.equal(secondPage, true);

  const fitted = layout.fitTextSizeToWidth(12, 77.28, 72.66);
  assert.ok(fitted < 12);
  assert.ok(77.28 * (fitted / 12) <= 72.66 + 1e-8, "fitted text must not enter the next fragment");
  const narrow = layout.fitTextSizeToWidth(12, 4.9, 3.0);
  assert.ok(narrow < 8, "narrow punctuation must not be forced to the old 8pt minimum width");

  const adjacent = layout.isTextMergeGeometryCompatible({
    previousTop: 20,
    previousRight: 100,
    previousFontSize: 16,
    currentTop: 20.2,
    currentLeft: 105,
    currentFontSize: 16,
    sameContainer: true
  });
  assert.equal(adjacent, true);
  const differentCell = layout.isTextMergeGeometryCompatible({
    previousTop: 20,
    previousRight: 100,
    previousFontSize: 16,
    currentTop: 20,
    currentLeft: 105,
    currentFontSize: 16,
    sameContainer: false
  });
  assert.equal(differentCell, false, "text in separate table cells must never merge");
  const distant = layout.isTextMergeGeometryCompatible({
    previousTop: 20,
    previousRight: 100,
    previousFontSize: 16,
    currentTop: 20,
    currentLeft: 140,
    currentFontSize: 16,
    sameContainer: true
  });
  assert.equal(distant, false, "large same-line gaps must not merge");

  const positionedRuns = layout.buildEncodablePositionedRuns(
    [
      { text: "앞", left: 0, top: 10, right: 12, bottom: 28 },
      { text: "😀", left: 12, top: 10, right: 31, bottom: 28 },
      { text: "뒤", left: 31, top: 10, right: 43, bottom: 28 }
    ],
    16,
    (text) => text === "😀" ? "" : text
  );
  assert.deepEqual(positionedRuns.map((run) => [run.text, run.left, run.right]), [
    ["앞", 0, 12],
    ["뒤", 31, 43]
  ], "supported text around an unsupported emoji must retain its original x position");

  const spacedRun = layout.buildEncodablePositionedRuns(
    [
      { text: "한글", left: 0, top: 10, right: 24, bottom: 28 },
      { text: " ", left: 24, top: 10, right: 30, bottom: 28 },
      { text: "선택", left: 30, top: 10, right: 54, bottom: 28 }
    ],
    16,
    (text) => text
  );
  assert.deepEqual(spacedRun.map((run) => run.text), ["한글 선택"], "selectable text must preserve spaces between graphemes");

  const leadingSeparatorRun = layout.buildEncodablePositionedRuns(
    [
      { text: " ", left: 24, top: 10, right: 30, bottom: 28 },
      { text: "선", left: 30, top: 10, right: 42, bottom: 28 },
      { text: "택", left: 42, top: 10, right: 54, bottom: 28 }
    ],
    16,
    (text) => text
  );
  assert.deepEqual(
    leadingSeparatorRun.map((run) => run.text),
    [" 선택"],
    "a rendered whitespace-only DOM node must survive as a leading PDF text separator"
  );

  const renderedBoundary = layout.isRenderedWhitespaceBoundaryCompatible({
    previous: { text: "한글", left: 0, top: 10, right: 24, bottom: 28 },
    separator: { text: " ", left: 24, top: 10, right: 30, bottom: 28 },
    current: { text: "선택", left: 30, top: 10, right: 54, bottom: 28 },
    fontSize: 16,
    sameContainer: true
  });
  assert.equal(renderedBoundary, true, "a measured inline whitespace boundary must be preserved");

  const leadingPreservedWhitespace = layout.isRenderedLeadingWhitespaceBoundaryCompatible({
    separator: { text: "    ", left: 0, top: 40, right: 24, bottom: 58 },
    adjacent: { text: "code", left: 24, top: 40, right: 62, bottom: 58 },
    fontSize: 16,
    sameContainer: true
  });
  assert.equal(leadingPreservedWhitespace, true, "preformatted leading indentation must remain selectable");
  const trailingPreservedWhitespace = layout.isRenderedTrailingWhitespaceBoundaryCompatible({
    separator: { text: "   ", left: 62, top: 40, right: 80, bottom: 58 },
    adjacent: { text: "code", left: 24, top: 40, right: 62, bottom: 58 },
    fontSize: 16,
    sameContainer: true
  });
  assert.equal(trailingPreservedWhitespace, true, "preformatted trailing spaces must remain selectable");
  assert.equal(
    layout.isRenderedLeadingWhitespaceBoundaryCompatible({
      separator: { text: "    ", left: 0, top: 40, right: 24, bottom: 58 },
      adjacent: { text: "code", left: 24, top: 70, right: 62, bottom: 88 },
      fontSize: 16,
      sameContainer: true
    }),
    false,
    "edge whitespace from another visual line must not attach"
  );
  assert.equal(
    layout.isRenderedTrailingWhitespaceBoundaryCompatible({
      separator: { text: "   ", left: 62, top: 40, right: 80, bottom: 58 },
      adjacent: { text: "code", left: 24, top: 40, right: 62, bottom: 58 },
      fontSize: 16,
      sameContainer: false
    }),
    false,
    "edge whitespace must not cross a container boundary"
  );

  const wrappedBoundary = layout.isRenderedWhitespaceBoundaryCompatible({
    previous: { text: "한글", left: 100, top: 10, right: 124, bottom: 28 },
    separator: { text: " ", left: 0, top: 40, right: 6, bottom: 58 },
    current: { text: "선택", left: 6, top: 40, right: 30, bottom: 58 },
    fontSize: 16,
    sameContainer: true
  });
  assert.equal(wrappedBoundary, false, "a line wrap must not create a leading space on the next visual line");

  const zeroWidthBoundary = layout.isRenderedWhitespaceBoundaryCompatible({
    previous: { text: "한글", left: 0, top: 10, right: 24, bottom: 28 },
    separator: { text: " ", left: 24, top: 10, right: 24, bottom: 28 },
    current: { text: "선택", left: 24, top: 10, right: 48, bottom: 28 },
    fontSize: 16,
    sameContainer: true
  });
  assert.equal(zeroWidthBoundary, false, "CSS-suppressed whitespace must not become a fake PDF space");

  assert.equal(layout.normalizeRenderedWhitespaceText("   ", "normal"), " ");
  assert.equal(layout.normalizeRenderedWhitespaceText("   ", "pre-wrap"), "   ");
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "break-spaces", 4), "    ");
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "pre", 0), null);
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "pre", 0.25), " ");
  assert.equal(layout.normalizeRenderedWhitespaceText(" \r\n ", "pre-line"), null);
  assert.equal(layout.normalizeRenderedWhitespaceText("   ", "preserve-breaks wrap"), " ");
  assert.equal(layout.normalizeRenderedWhitespaceText(" \r\n\t ", "preserve-spaces wrap", 8), "    ");
  assert.equal(
    layout.normalizeRenderedWhitespaceText("  \n  ", "pre"),
    null,
    "preserved newlines must remain visual line boundaries instead of becoming PDF spaces"
  );

  process.stdout.write("Verified fixed-page slice layout, grapheme segmentation, non-overlapping width fitting, page ownership, CSS-aware DOM whitespace boundaries, safe fragment merging, and positioned fallback runs.\n");
} finally {
  rmSync(helperDir, { recursive: true, force: true });
}
