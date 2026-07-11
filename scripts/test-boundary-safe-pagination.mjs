#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const helperDir = mkdtempSync(`${tmpdir()}/mobile-pdf-boundary-pagination-`);
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
  assert.equal(
    typeof layout.computePageBreaks,
    "function",
    "text-layout must export the production computePageBreaks helper"
  );

  verifyShortFinalIntervals(layout);
  verifyShallowTextCrossings(layout);
  verifyExactBoundaryContact(layout);
  verifyTouchingLinesUseTheLatestSafeBreak(layout);
  verifySameVisualRowMovesTogether(layout);
  verifyRejectedBlockDoesNotHideText(layout);
  verifyUnavoidableTextDoesNotHideMovableText(layout);
  verifyTextRetreatDoesNotCreateAvoidableCut(layout);
  verifyRetreatIsIterativelySafe(layout);
  verifyUnavoidableSplitsStillProgress(layout);
  verifyInvalidGeometryAndOptions(layout);
  verifyPaginationLimit(layout);
  verifyMinimumTextRetreat(layout);
  verifyDenseOverlappingText(layout);
  verifyDeterministicAdversarialDocuments(layout);

  process.stdout.write(
    "Verified boundary-safe pagination: fractional A4 geometry, subpixel tails, shallow glyph crossings, " +
    "exact/touching rows, multi-cell rows, candidate shadowing, iterative retreat, oversize fallbacks, " +
    "invalid geometry/options, the 4,096-page safety limit, dense overlap, and 2,048 deterministic " +
    "adversarial documents.\n"
  );
} finally {
  rmSync(helperDir, { recursive: true, force: true });
}

function verifyShortFinalIntervals(layout) {
  const pageHeights = [
    1000.75,
    768 * (297 / 210),
    794 * (297 / 210),
    1024 * (297 / 210)
  ];
  const tails = [0.01, 0.125, 0.5, 0.999999];

  for (const pageHeight of pageHeights) {
    for (const tail of tails) {
      const contentHeight = pageHeight + tail;
      const breaks = layout.computePageBreaks(contentHeight, pageHeight, []);
      verifyBreakSequence(breaks, contentHeight, pageHeight, `tail=${tail}, pageHeight=${pageHeight}`);
      assert.equal(breaks.length, 3, "any visible tail beyond a physical page needs a following page");
      assertClose(breaks[1], pageHeight, "an empty first page must end at its physical boundary");
      assertClose(breaks[2] - breaks[1], tail, "the final subpixel interval must not be discarded");
    }
  }
}

function verifyShallowTextCrossings(layout) {
  const pageHeights = [1000, 768 * (297 / 210), 794 * (297 / 210)];
  const crossingDepths = [0.01, 0.125, 0.5, 1.999999, 2, 2.000001, 7.75];

  for (const pageHeight of pageHeights) {
    for (const crossingDepth of crossingDepths) {
      const line = textLine(pageHeight - 18.25, pageHeight + crossingDepth);
      const contentHeight = pageHeight + 240;
      const breaks = layout.computePageBreaks(contentHeight, pageHeight, [line]);
      verifyBreakSequence(
        breaks,
        contentHeight,
        pageHeight,
        `crossing=${crossingDepth}, pageHeight=${pageHeight}`
      );
      assert.ok(
        breaks[1] <= line.top,
        `a ${crossingDepth}px boundary crossing must move the whole text rect to the following page`
      );
      assertFragmentHasOneContainingPage(breaks, line, `crossing=${crossingDepth}`);
    }
  }
}

function verifyExactBoundaryContact(layout) {
  const pageHeight = 1000;
  const contentHeight = 1250;
  const endingAtBreak = textLine(980, pageHeight);
  const startingAtBreak = textLine(pageHeight, 1020);
  const breaks = layout.computePageBreaks(contentHeight, pageHeight, [endingAtBreak, startingAtBreak]);

  verifyBreakSequence(breaks, contentHeight, pageHeight, "exact boundary contact");
  assertClose(breaks[1], pageHeight, "touching a boundary without crossing it must not waste page space");
  assertFragmentHasOneContainingPage(breaks, endingAtBreak, "line ending at boundary");
  assertFragmentHasOneContainingPage(breaks, startingAtBreak, "line starting at boundary");
}

function verifyTouchingLinesUseTheLatestSafeBreak(layout) {
  const pageHeight = 1000;
  const contentHeight = 1300;
  const lines = [
    textLine(990, 1010),
    textLine(970, 990),
    textLine(950, 970)
  ];
  const breaks = layout.computePageBreaks(contentHeight, pageHeight, lines);

  verifyBreakSequence(breaks, contentHeight, pageHeight, "touching text lines");
  assertClose(
    breaks[1],
    990,
    "a safe text retreat should stop at the crossing line top instead of cascading through touching lines"
  );
  for (const line of lines) assertFragmentHasOneContainingPage(breaks, line, "touching text lines");
}

function verifySameVisualRowMovesTogether(layout) {
  const pageHeight = 1000;
  const contentHeight = 1300;
  const tableCellFragments = [
    { ...textLine(988.5, 1003.25), left: 0, right: 180 },
    { ...textLine(988.5, 1003.25), left: 180, right: 420 },
    { ...textLine(988.5, 1003.25), left: 420, right: 600 }
  ];
  const breaks = layout.computePageBreaks(contentHeight, pageHeight, tableCellFragments);

  verifyBreakSequence(breaks, contentHeight, pageHeight, "same-row table cells");
  assertClose(breaks[1], 988.5, "all text fragments on one visual row must move at one shared boundary");
  for (const fragment of tableCellFragments) {
    assertFragmentHasOneContainingPage(breaks, fragment, "same-row table cell");
  }
}

function verifyRejectedBlockDoesNotHideText(layout) {
  const pageHeight = 1000;
  const contentHeight = 1300;
  const earlyParagraph = keepBlock(100, 1010, 2);
  const crossingLine = textLine(990, 1010);
  const breaks = layout.computePageBreaks(contentHeight, pageHeight, [earlyParagraph, crossingLine]);

  verifyBreakSequence(breaks, contentHeight, pageHeight, "rejected high-priority candidate");
  assert.ok(
    breaks[1] <= crossingLine.top,
    "an unusable high-priority retreat candidate must not hide a usable text-line candidate"
  );
  assertFragmentHasOneContainingPage(breaks, crossingLine, "candidate-shadowed text line");
}

function verifyUnavoidableTextDoesNotHideMovableText(layout) {
  const pageHeight = 1000;
  const contentHeight = 1400;
  const unavoidableNearStartLine = textLine(50, 1005);
  const movableBoundaryLine = textLine(990, 1010);
  const breaks = layout.computePageBreaks(
    contentHeight,
    pageHeight,
    [unavoidableNearStartLine, movableBoundaryLine],
    { minimumAdvancePx: 72 }
  );

  verifyBreakSequence(breaks, contentHeight, pageHeight, "mixed unavoidable and movable text");
  assertClose(
    breaks[1],
    movableBoundaryLine.top,
    "an unavoidable near-start text crossing must not force a separate movable line to be clipped too"
  );
  assertFragmentHasOneContainingPage(breaks, movableBoundaryLine, "movable line beside unavoidable text");
}

function verifyTextRetreatDoesNotCreateAvoidableCut(layout) {
  const pageHeight = 1000;
  const contentHeight = 1400;
  const gapBlocks = [
    keepBlock(100, 592, 2),
    keepBlock(700, 720, 2)
  ];
  const lineSafeAtPhysicalBreak = textLine(50, 595);
  const lineCrossingHeuristicBreak = textLine(590, 610);
  const breaks = layout.computePageBreaks(
    contentHeight,
    pageHeight,
    [...gapBlocks, lineSafeAtPhysicalBreak, lineCrossingHeuristicBreak],
    { minimumAdvancePx: 72, paddingPx: 8 }
  );

  verifyBreakSequence(breaks, contentHeight, pageHeight, "retreat-created avoidable crossing");
  assertClose(
    breaks[1],
    pageHeight,
    "a heuristic break must fall back to the physical boundary when text retreat would cut an earlier line"
  );
  assertFragmentHasOneContainingPage(breaks, lineSafeAtPhysicalBreak, "line safe at physical boundary");
  assertFragmentHasOneContainingPage(breaks, lineCrossingHeuristicBreak, "line crossing only heuristic boundary");
}

function verifyRetreatIsIterativelySafe(layout) {
  const pageHeight = 1000;
  const contentHeight = 1300;
  const lines = [
    textLine(990, 1010),
    textLine(975, 985),
    textLine(960, 970),
    textLine(945, 955)
  ];
  const breaks = layout.computePageBreaks(contentHeight, pageHeight, lines);

  verifyBreakSequence(breaks, contentHeight, pageHeight, "iterative retreat");
  for (const line of lines) {
    assert.equal(
      crossesBoundary(line, breaks[1]),
      false,
      `retreating the break must not create a new cut through ${line.top}-${line.bottom}`
    );
  }
  for (const line of lines) {
    assertFragmentHasOneContainingPage(breaks, line, `iterative line ${line.top}-${line.bottom}`);
  }
}

function verifyUnavoidableSplitsStillProgress(layout) {
  const cases = [
    {
      label: "element taller than a page",
      contentHeight: 2400,
      pageHeight: 1000,
      blocks: [textLine(100, 1300)]
    },
    {
      label: "crossing too near minimum advance",
      contentHeight: 1400,
      pageHeight: 1000,
      blocks: [textLine(50, 1005)]
    },
    {
      label: "element beginning at document top",
      contentHeight: 2300,
      pageHeight: 999.75,
      blocks: [textLine(0, 2200)]
    }
  ];

  for (const scenario of cases) {
    const breaks = layout.computePageBreaks(
      scenario.contentHeight,
      scenario.pageHeight,
      scenario.blocks
    );
    verifyBreakSequence(breaks, scenario.contentHeight, scenario.pageHeight, scenario.label);
    assert.ok(breaks.length < 100, `${scenario.label} must make bounded progress`);
  }
}

function verifyInvalidGeometryAndOptions(layout) {
  for (const contentHeight of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.throws(
      () => layout.computePageBreaks(contentHeight, 1000, []),
      RangeError,
      `invalid content height ${contentHeight} must be rejected`
    );
  }
  for (const pageHeight of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
    assert.throws(
      () => layout.computePageBreaks(1000, pageHeight, []),
      RangeError,
      `invalid page height ${pageHeight} must be rejected`
    );
  }
  assert.deepEqual(layout.computePageBreaks(0, 1000, []), [0], "empty content must not create an empty page");

  const invalidBlocks = [
    keepBlock(Number.NaN, 500, 1),
    keepBlock(100, Number.POSITIVE_INFINITY, 1),
    keepBlock(500, 100, 1),
    keepBlock(100, 500, Number.NaN),
    keepBlock(Number.NEGATIVE_INFINITY, 500, 1)
  ];
  const baseline = layout.computePageBreaks(2300.5, 1000.25, []);
  assert.deepEqual(
    layout.computePageBreaks(2300.5, 1000.25, invalidBlocks),
    baseline,
    "invalid block geometry must be ignored instead of poisoning pagination"
  );

  const optionCases = [
    { paddingPx: -100, minimumAdvancePx: -100 },
    { paddingPx: Number.NaN, minimumAdvancePx: Number.NaN },
    { paddingPx: Number.POSITIVE_INFINITY, minimumAdvancePx: Number.POSITIVE_INFINITY },
    { paddingPx: Number.MAX_VALUE, minimumAdvancePx: Number.MAX_VALUE },
    { paddingPx: 0.0001, minimumAdvancePx: 0.0001, textPriority: 7 }
  ];
  for (const [index, options] of optionCases.entries()) {
    const linePriority = options.textPriority ?? 1;
    const line = keepBlock(990, 1000.25, linePriority);
    const breaks = layout.computePageBreaks(2400.75, 1000.25, [line], options);
    verifyBreakSequence(breaks, 2400.75, 1000.25, `option case ${index}`);
  }

  const customTextLine = keepBlock(990, 1010, 7);
  const customPriorityBreaks = layout.computePageBreaks(1300, 1000, [customTextLine], {
    textPriority: 7
  });
  assertClose(customPriorityBreaks[1], customTextLine.top, "custom text priority must receive strict text safety");

  for (const [contentHeight, pageHeight] of [
    [0.01, 0.001],
    [Number.MIN_VALUE * 2, Number.MIN_VALUE],
    [2_500_000_000_000.5, 1_000_000_000_000.125]
  ]) {
    const breaks = layout.computePageBreaks(contentHeight, pageHeight, []);
    verifyBreakSequence(breaks, contentHeight, pageHeight, `finite extreme ${contentHeight}/${pageHeight}`);
  }
}

function verifyPaginationLimit(layout) {
  const pageLimit = 4_096;
  const exactLimitBreaks = layout.computePageBreaks(pageLimit, 1, []);
  verifyBreakSequence(exactLimitBreaks, pageLimit, 1, "exact pagination limit");
  assert.equal(exactLimitBreaks.length - 1, pageLimit, "exactly 4,096 physical pages must remain supported");

  assert.throws(
    () => layout.computePageBreaks(pageLimit + 0.01, 1, []),
    RangeError,
    "a document requiring at least 4,097 physical pages must fail before allocating every break"
  );
  assert.throws(
    () => layout.computePageBreaks(1, 1e-12, []),
    RangeError,
    "a finite but pathological page ratio must not run effectively forever"
  );
  assert.throws(
    () => layout.computePageBreaks(1, Number.MIN_VALUE, []),
    RangeError,
    "a positive subnormal page height must not cause a non-progressing loop"
  );

  const contentHeight = pageLimit * 1000;
  const earlyCrossingLine = textLine(900, 1001);
  assert.throws(
    () => layout.computePageBreaks(contentHeight, 1000, [earlyCrossingLine]),
    RangeError,
    "heuristic retreats that push the actual page count over 4,096 must also be bounded"
  );
}

function verifyMinimumTextRetreat(layout) {
  const pageHeight = 1000;
  const contentHeight = 1400;
  const configuredMinimum = 72;

  for (const top of [0.0001, 1, 50, 72]) {
    const line = textLine(top, 1005);
    const breaks = layout.computePageBreaks(contentHeight, pageHeight, [line], {
      minimumAdvancePx: configuredMinimum
    });
    verifyBreakSequence(breaks, contentHeight, pageHeight, `minimum retreat top=${top}`);
    assertClose(
      breaks[1],
      pageHeight,
      `a text line beginning at ${top}px must not create a nearly empty first page`
    );
  }

  const safelyMovableLine = textLine(72.25, 1005);
  const safeBreaks = layout.computePageBreaks(contentHeight, pageHeight, [safelyMovableLine], {
    minimumAdvancePx: configuredMinimum
  });
  assert.ok(
    safeBreaks[1] >= configuredMinimum && safeBreaks[1] <= safelyMovableLine.top,
    "a line beyond the configured minimum advance may move intact to the next page"
  );

  const cappedMinimumLine = textLine(151, 1005);
  const cappedMinimumBreaks = layout.computePageBreaks(contentHeight, pageHeight, [cappedMinimumLine], {
    minimumAdvancePx: Number.MAX_VALUE
  });
  assertClose(
    cappedMinimumBreaks[1],
    cappedMinimumLine.top,
    "text retreat minimum must cap at 15% of the physical page even for an extreme option"
  );
}

function verifyDenseOverlappingText(layout) {
  const pageHeight = 1000;
  const contentHeight = 1800;
  const nestedLines = Array.from({ length: 512 }, (_unused, index) =>
    textLine(600 + index * 0.5, 1000.01 + index * 0.3)
  );
  const sameRow = Array.from({ length: 2_500 }, (_unused, index) => ({
    ...textLine(988.125, 1001.875),
    left: index,
    right: index + 1
  }));
  const blocks = Object.freeze([...nestedLines, ...sameRow]);
  const breaks = layout.computePageBreaks(contentHeight, pageHeight, blocks);

  verifyBreakSequence(breaks, contentHeight, pageHeight, "dense overlapping text");
  assertClose(breaks[1], 600, "the earliest nested crossing must establish one shared safe boundary");
  assert.equal(blocks.length, 3_012, "pagination must not mutate or truncate the caller's block array");
  for (const line of [...nestedLines, ...sameRow]) {
    assertFragmentHasOneContainingPage(breaks, line, "dense overlapping text line");
  }
}

function verifyDeterministicAdversarialDocuments(layout) {
  const random = xorshift32(0xa4c11f5);

  for (let documentIndex = 0; documentIndex < 2_048; documentIndex += 1) {
    const width = 500 + random() * 700;
    const pageHeight = width * (297 / 210) + random();
    const contentHeight = pageHeight * (1.05 + random() * 4) + random();
    const idealBreak = pageHeight;
    const lines = [];

    const crossingLine = textLine(
      idealBreak - (10 + random() * 26),
      idealBreak + (0.01 + random() * 2.5)
    );
    lines.push(crossingLine);

    let chainBottom = crossingLine.top - 4;
    const chainLength = 1 + Math.floor(random() * 8);
    for (let index = 0; index < chainLength; index += 1) {
      const height = 7 + random() * 11;
      const overlap = 0.25 + random() * Math.min(3, height / 2);
      const top = chainBottom - height + overlap;
      lines.push(textLine(top, chainBottom));
      chainBottom = top - (3 + random() * 8);
    }

    const blockers = [
      keepBlock(pageHeight * (0.08 + random() * 0.08), idealBreak + random() * 18, 2),
      keepBlock(pageHeight * (0.12 + random() * 0.12), idealBreak + random() * 24, 3)
    ];
    const breaks = layout.computePageBreaks(contentHeight, pageHeight, [...blockers, ...lines]);
    verifyBreakSequence(breaks, contentHeight, pageHeight, `adversarial document ${documentIndex}`);

    for (const line of lines) {
      assert.equal(
        crossesBoundary(line, breaks[1]),
        false,
        `adversarial document ${documentIndex} cut a movable text line at ${breaks[1]}`
      );
      assertFragmentHasOneContainingPage(breaks, line, `adversarial document ${documentIndex}`);
    }
  }
}

function verifyBreakSequence(breaks, contentHeight, pageHeight, label) {
  assert.ok(Array.isArray(breaks), `${label}: breaks must be an array`);
  assert.equal(breaks[0], 0, `${label}: pagination must begin at zero`);
  assertClose(breaks.at(-1), contentHeight, `${label}: pagination must cover the full visible height`);
  assert.ok(breaks.length < 10_000, `${label}: pagination must be bounded`);

  for (let index = 1; index < breaks.length; index += 1) {
    const previous = breaks[index - 1];
    const current = breaks[index];
    assert.ok(Number.isFinite(current), `${label}: break ${index} must be finite`);
    assert.ok(current > previous, `${label}: break ${index} must make positive progress`);
    assert.ok(
      current - previous <= pageHeight + numericTolerance(pageHeight),
      `${label}: interval ${index} exceeds the physical page (${current - previous} > ${pageHeight})`
    );
  }
}

function assertFragmentHasOneContainingPage(breaks, fragment, label) {
  const containers = [];
  for (let index = 0; index < breaks.length - 1; index += 1) {
    if (fragment.top >= breaks[index] - numericTolerance(fragment.top) &&
        fragment.bottom <= breaks[index + 1] + numericTolerance(fragment.bottom)) {
      containers.push(index);
    }
  }
  assert.equal(containers.length, 1, `${label}: a movable text rect must be fully contained by exactly one page`);
}

function crossesBoundary(fragment, boundary) {
  return fragment.top < boundary && fragment.bottom > boundary;
}

function textLine(top, bottom) {
  return keepBlock(top, bottom, 1);
}

function keepBlock(top, bottom, priority) {
  return { left: 0, top, right: 600, bottom, priority };
}

function assertClose(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) <= numericTolerance(Math.max(Math.abs(actual), Math.abs(expected))),
    `${message}: expected ${expected}, received ${actual}`
  );
}

function numericTolerance(value) {
  return Math.max(1e-10, Number.EPSILON * Math.max(1, Math.abs(value)) * 16);
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
