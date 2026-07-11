#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const TEST_SEED = 0xc0d3f17e;
const helperDir = mkdtempSync(`${tmpdir()}/mobile-pdf-adversarial-text-layout-`);
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
  const random = xorshift32(TEST_SEED);

  verifyThousandsOfGraphemes(layout, random);
  verifyRandomPagination(layout, random);
  verifyExtremeGeometry(layout, random);
  verifyUnsupportedGlyphRuns(layout, random);
  verifyWhitespaceModes(layout);

  process.stdout.write(
    `Verified adversarial text layout with deterministic seed 0x${TEST_SEED.toString(16)}: ` +
    "4,096 grapheme atoms, 512 mixed Unicode strings, 500 randomized paginations, " +
    "extreme geometry, 750 unsupported-glyph layouts, and CSS whitespace modes.\n"
  );
} finally {
  rmSync(helperDir, { recursive: true, force: true });
}

function verifyThousandsOfGraphemes(layout, random) {
  const atoms = Array.from({ length: 4_096 }, () => randomGraphemeAtom(random));
  const segmentedAtoms = atoms.map((atom, index) => {
    const native = layout.segmentTextGraphemes(atom);
    assert.equal(native.length, 1, `generated atom ${index} must be one native grapheme: ${describe(atom)}`);
    assert.equal(native[0].text, atom);
    const fallback = layout.segmentTextGraphemesFallback(atom);
    assert.deepEqual(
      fallback.map((segment) => segment.text),
      [atom],
      `fallback must retain generated atom ${index}: ${describe(atom)}`
    );
    verifySegmentCoverage(atom, native, `native atom ${index}`);
    verifySegmentCoverage(atom, fallback, `fallback atom ${index}`);
    return atom;
  });

  const separated = segmentedAtoms.join("|");
  const expectedSeparated = [];
  for (const [index, atom] of segmentedAtoms.entries()) {
    if (index > 0) expectedSeparated.push("|");
    expectedSeparated.push(atom);
  }
  for (const [label, segments] of [
    ["native separated corpus", layout.segmentTextGraphemes(separated)],
    ["fallback separated corpus", layout.segmentTextGraphemesFallback(separated)]
  ]) {
    verifySegmentCoverage(separated, segments, label);
    assert.deepEqual(segments.map((segment) => segment.text), expectedSeparated, `${label} changed a grapheme boundary`);
  }

  for (let iteration = 0; iteration < 512; iteration += 1) {
    const count = randomInteger(random, 8, 72);
    let text = "";
    for (let index = 0; index < count; index += 1) text += randomChoice(random, segmentedAtoms);
    const native = layout.segmentTextGraphemes(text);
    const fallback = layout.segmentTextGraphemesFallback(text);
    verifySegmentCoverage(text, native, `native mixed corpus ${iteration}`);
    verifySegmentCoverage(text, fallback, `fallback mixed corpus ${iteration}`);
    assert.deepEqual(
      fallback.map((segment) => segment.text),
      native.map((segment) => segment.text),
      `fallback disagreed with Intl.Segmenter in mixed corpus ${iteration}: ${describe(text)}`
    );
  }
}

function verifyRandomPagination(layout, random) {
  for (let documentIndex = 0; documentIndex < 500; documentIndex += 1) {
    const pageHeight = randomInteger(random, 64, 4_096) + random();
    const documentHeight = pageHeight * (0.1 + random() * 18);
    const pages = [];
    let pageTop = 0;
    while (pageTop < documentHeight) {
      const requestedAdvance = pageHeight * (0.03 + random() * 2.4);
      const candidate = Math.min(documentHeight, pageTop + requestedAdvance);
      let pageBottom = layout.clampPageBreakToPhysicalPage(pageTop, candidate, pageHeight);
      if (pageBottom <= pageTop) pageBottom = Math.min(documentHeight, pageTop + Math.min(1, pageHeight));
      pages.push({ top: pageTop, bottom: pageBottom });
      assert.ok(pageBottom > pageTop, `document ${documentIndex} produced an empty page`);
      assert.ok(
        pageBottom - pageTop <= pageHeight + Number.EPSILON * Math.max(1, pageBottom),
        `document ${documentIndex} exceeded the physical-page interval`
      );
      const slice = layout.getFixedPageSliceLayout(pageTop, pageBottom, pageHeight);
      assert.ok(slice.contentHeightPx > 0 && slice.contentHeightPx <= pageHeight);
      assert.ok(slice.blankHeightPx >= 0 && slice.blankHeightPx < pageHeight);
      assert.ok(Math.abs(slice.contentHeightPx + slice.blankHeightPx - pageHeight) < 1e-7);
      pageTop = pageBottom;
      assert.ok(pages.length < 1_000, `document ${documentIndex} pagination failed to make bounded progress`);
    }

    assert.equal(pages[0].top, 0);
    assert.equal(pages.at(-1).bottom, documentHeight);
    for (let index = 1; index < pages.length; index += 1) {
      assert.equal(pages[index - 1].bottom, pages[index].top, `document ${documentIndex} contains a gap or overlap`);
    }

    for (let fragmentIndex = 0; fragmentIndex < 128; fragmentIndex += 1) {
      const center = random() * documentHeight;
      const fragmentHeight = random() * pageHeight * 1.75;
      const top = center - fragmentHeight / 2;
      const bottom = center + fragmentHeight / 2;
      const owners = pages.filter((page) =>
        layout.verticalCenterBelongsToPage(top, bottom, page.top, page.bottom)
      );
      assert.equal(
        owners.length,
        1,
        `fragment ${fragmentIndex} in document ${documentIndex} was omitted or duplicated at ${center}`
      );
    }

    for (let index = 1; index < pages.length; index += 1) {
      const boundary = pages[index].top;
      const exactlyOnBoundary = pages.filter((page) =>
        layout.verticalCenterBelongsToPage(boundary, boundary, page.top, page.bottom)
      );
      assert.deepEqual(exactlyOnBoundary, [pages[index]], "a boundary center must belong only to the following page");
      const previousValue = boundary - Math.min(Number.EPSILON * Math.max(1, boundary) * 2, (boundary - pages[index - 1].top) / 2);
      if (previousValue < boundary) {
        const immediatelyBefore = pages.filter((page) =>
          layout.verticalCenterBelongsToPage(previousValue, previousValue, page.top, page.bottom)
        );
        assert.deepEqual(immediatelyBefore, [pages[index - 1]], "a center below a boundary must remain on the previous page");
      }
    }
  }
}

function verifyExtremeGeometry(layout, random) {
  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const value of invalid) {
    assert.throws(() => layout.clampPageBreakToPhysicalPage(value, 100, 100), RangeError);
    assert.throws(() => layout.clampPageBreakToPhysicalPage(0, value, 100), RangeError);
    assert.throws(() => layout.clampPageBreakToPhysicalPage(0, 100, value), RangeError);
    assert.throws(() => layout.getFixedPageSliceLayout(value, 100, 100), RangeError);
    assert.throws(() => layout.getFixedPageSliceLayout(0, value, 100), RangeError);
    assert.throws(() => layout.getFixedPageSliceLayout(0, 100, value), RangeError);
    assert.equal(layout.startsInsidePageBreakInterval(value, 0, 100, 1, 1), false);
    assert.equal(layout.startsInsidePageBreakInterval(50, value, 100, 1, 1), false);
    assert.equal(layout.startsInsidePageBreakInterval(50, 0, value, 1, 1), false);
    assert.equal(layout.verticalCenterBelongsToPage(value, 1, 0, 100), false);
    assert.equal(layout.verticalCenterBelongsToPage(0, value, 0, 100), false);
  }
  for (const [top, bottom, height] of [
    [-1, 100, 100],
    [0, 0, 100],
    [10, 9, 100],
    [0, 100, 0],
    [0, 100, -1]
  ]) {
    assert.throws(() => layout.getFixedPageSliceLayout(top, bottom, height), RangeError);
  }
  assert.throws(() => layout.clampPageBreakToPhysicalPage(-1, 1, 1), RangeError);
  assert.throws(() => layout.clampPageBreakToPhysicalPage(0, 1, 0), RangeError);

  const fitValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0, 0, Number.MIN_VALUE, 1, 12, Number.MAX_VALUE];
  for (let index = 0; index < 2_000; index += 1) {
    const size = randomChoice(random, fitValues);
    const measured = randomChoice(random, fitValues);
    const available = randomChoice(random, fitValues);
    const fitted = layout.fitTextSizeToWidth(size, measured, available);
    assert.ok(
      Number.isFinite(fitted) && fitted > 0,
      `width fitting must return a finite usable size (size=${size}, measured=${measured}, available=${available}, fitted=${fitted})`
    );
    if (Number.isFinite(size) && size > 0 && Number.isFinite(measured) && measured > 0 &&
        Number.isFinite(available) && available > 0 && measured > available &&
        size * (available / measured) >= 1) {
      assert.ok(measured * (fitted / size) <= available * (1 + 1e-12), "a feasible width fit must not overflow");
    }
  }

  const validMerge = {
    previousTop: 10,
    previousRight: 20,
    previousFontSize: 16,
    currentTop: 10,
    currentLeft: 20,
    currentFontSize: 16,
    sameContainer: true
  };
  assert.equal(layout.isTextMergeGeometryCompatible(validMerge), true, "zero-gap fragments should merge");
  for (const key of ["previousTop", "previousRight", "previousFontSize", "currentTop", "currentLeft", "currentFontSize"]) {
    for (const value of invalid) {
      assert.equal(
        layout.isTextMergeGeometryCompatible({ ...validMerge, [key]: value }),
        false,
        `${key}=${value} must not merge`
      );
    }
  }
  assert.equal(layout.isTextMergeGeometryCompatible({ ...validMerge, sameContainer: false }), false);

  const zeroHeightOwners = [
    layout.verticalCenterBelongsToPage(100, 100, 0, 100),
    layout.verticalCenterBelongsToPage(100, 100, 100, 200)
  ];
  assert.deepEqual(zeroHeightOwners, [false, true], "zero-height text at a break must have exactly one owner");
}

function verifyUnsupportedGlyphRuns(layout, random) {
  const supported = ["가", "힣", "ᄒᆞᆫ", "A", "é", "e\u0301", "中"];
  const unsupported = ["😀", "👨‍👩‍👧‍👦", "🇰🇷", "🫠", "\u{10ffff}"];
  const unsupportedSet = new Set(unsupported);

  for (let iteration = 0; iteration < 750; iteration += 1) {
    const graphemes = [];
    const expectedRuns = [];
    let left = random() * 50;
    const top = random() * 500;
    const sequenceLength = randomInteger(random, 4, 60);
    let expected = null;
    for (let index = 0; index < sequenceLength; index += 1) {
      const isUnsupported = random() < 0.38;
      const text = randomChoice(random, isUnsupported ? unsupported : supported);
      const gap = random() * 0.2;
      left += gap;
      const width = 2 + random() * 17;
      const item = { text, left, top, right: left + width, bottom: top + 18 };
      graphemes.push(item);
      left = item.right;
      if (isUnsupported) {
        if (expected) expectedRuns.push(expected);
        expected = null;
      } else if (!expected) {
        expected = { ...item };
      } else {
        expected.text += text;
        expected.right = item.right;
      }
    }
    if (expected) expectedRuns.push(expected);

    const actual = layout.buildEncodablePositionedRuns(
      graphemes,
      16,
      (text) => unsupportedSet.has(text) ? "" : text
    );
    assert.equal(actual.length, expectedRuns.length, `unsupported run count changed at iteration ${iteration}`);
    for (let index = 0; index < expectedRuns.length; index += 1) {
      assert.equal(actual[index].text, expectedRuns[index].text);
      assert.equal(actual[index].left, expectedRuns[index].left, "unsupported glyphs must not shift the following run left");
      assert.equal(actual[index].right, expectedRuns[index].right, "run bounds must retain the source coordinates");
      assert.equal(actual[index].top, expectedRuns[index].top);
      assert.equal(actual[index].bottom, expectedRuns[index].bottom);
    }
  }

  const allUnsupported = unsupported.map((text, index) => ({
    text,
    left: index * 20,
    top: 0,
    right: index * 20 + 19,
    bottom: 20
  }));
  assert.deepEqual(
    layout.buildEncodablePositionedRuns(allUnsupported, 16, () => ""),
    [],
    "an entirely unsupported sequence must not create phantom runs"
  );
}

function verifyWhitespaceModes(layout) {
  const collapseCases = ["normal", "nowrap", "pre-line", "  NORMAL  "];
  for (const mode of collapseCases) {
    assert.equal(layout.normalizeRenderedWhitespaceText(" \t  ", mode, 4), " ", `${mode} must collapse ASCII whitespace`);
  }
  for (const mode of ["pre", "pre-wrap", "break-spaces", "preserve nowrap", "preserve wrap"]) {
    assert.equal(layout.normalizeRenderedWhitespaceText("  \t ", mode, 4), "       ", `${mode} must preserve spaces and expand tabs`);
  }
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "pre", 1), " ");
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "pre", 4), "    ");
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "pre", 16), " ".repeat(16));
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "pre", 99), " ".repeat(16), "tab expansion must remain bounded");
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "pre", "garbage"), " ".repeat(8));
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "pre", 0), null, "CSS tab-size:0 must not synthesize visible spacing");
  assert.equal(
    layout.normalizeRenderedWhitespaceText("\t", "pre", 0.25),
    " ",
    "a positive fractional tab width must retain a selectable separator"
  );

  for (const mode of ["pre", "pre-wrap", "break-spaces", "pre-line", "preserve wrap"]) {
    assert.equal(
      layout.normalizeRenderedWhitespaceText("  \r\n\t ", mode, 4),
      null,
      `${mode} must retain a newline as a visual boundary rather than a PDF space`
    );
  }
  assert.equal(layout.normalizeRenderedWhitespaceText("  \r\n\t ", "normal", 4), " ");
  assert.equal(
    layout.normalizeRenderedWhitespaceText("   ", "preserve-breaks wrap", 4),
    " ",
    "CSS preserve-breaks must collapse spaces while retaining line boundaries"
  );
  assert.equal(layout.normalizeRenderedWhitespaceText("\r\n", "preserve-breaks wrap", 4), null);
  assert.equal(
    layout.normalizeRenderedWhitespaceText("\r\n", "preserve-spaces wrap", 4),
    " ",
    "CSS preserve-spaces converts a segment break to a preserved space"
  );
  assert.equal(layout.normalizeRenderedWhitespaceText("\t", "preserve-spaces wrap", 4), " ");

  const nbsp = "\u00a0";
  for (const mode of ["normal", "nowrap", "pre", "pre-wrap", "break-spaces", "pre-line"]) {
    assert.equal(layout.normalizeRenderedWhitespaceText(nbsp, mode, 4), nbsp, `${mode} must preserve NBSP`);
    assert.equal(
      layout.normalizeRenderedWhitespaceText(` ${nbsp} `, mode, 4),
      mode === "pre" || mode === "pre-wrap" || mode === "break-spaces" ? ` ${nbsp} ` : ` ${nbsp} `,
      `${mode} must not collapse NBSP into an ordinary separator`
    );
  }
  assert.equal(layout.normalizeRenderedWhitespaceText("not whitespace", "normal"), null);
  assert.equal(layout.normalizeRenderedWhitespaceText("", "pre"), null);
}

function verifySegmentCoverage(text, segments, label) {
  let offset = 0;
  for (const [index, segment] of segments.entries()) {
    assert.equal(segment.start, offset, `${label} has a gap or overlap before segment ${index}`);
    assert.ok(segment.end > segment.start, `${label} contains an empty segment ${index}`);
    assert.equal(segment.text, text.slice(segment.start, segment.end), `${label} has an incorrect UTF-16 slice at ${index}`);
    offset = segment.end;
  }
  assert.equal(offset, text.length, `${label} did not consume the entire string`);
  assert.equal(segments.map((segment) => segment.text).join(""), text, `${label} did not reconstruct the input`);
}

function randomGraphemeAtom(random) {
  const latinBases = ["A", "e", "o", "n", "가", "각", "힣"];
  const combiningMarks = ["\u0300", "\u0301", "\u0308", "\u0327", "\u034f", "\u20dd", "\ufe0f"];
  const oldInitials = ["ᄀ", "ᄂ", "ᄅ", "ᄒ", "ꥠ", "ꥼ"];
  const oldVowels = ["ᅡ", "ᅩ", "ᆞ", "ퟆ"];
  const oldFinals = ["ᆨ", "ᆫ", "ᇂ", "ퟋ"];
  const zwj = ["👨‍👩‍👧‍👦", "👩🏽‍💻", "👩‍🚀", "🏳️‍🌈", "🧑🏿‍🤝‍🧑🏻"];
  switch (randomInteger(random, 0, 5)) {
    case 0: {
      const base = randomChoice(random, latinBases).normalize("NFD");
      const count = randomInteger(random, 1, 4);
      let result = base;
      for (let index = 0; index < count; index += 1) result += randomChoice(random, combiningMarks);
      return result;
    }
    case 1:
      return randomChoice(random, oldInitials) + randomChoice(random, oldVowels) +
        (random() < 0.8 ? randomChoice(random, oldFinals) : "");
    case 2:
      return randomChoice(random, zwj);
    case 3: {
      const first = 0x1f1e6 + randomInteger(random, 0, 25);
      const second = 0x1f1e6 + randomInteger(random, 0, 25);
      return String.fromCodePoint(first, second);
    }
    case 4:
      return randomChoice(random, ["👍🏻", "👍🏽", "🙏🏿", "✍️", "#️⃣"]);
    default:
      return "\r\n";
  }
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

function randomInteger(random, minimum, maximum) {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function randomChoice(random, values) {
  return values[Math.floor(random() * values.length)];
}

function describe(value) {
  return Array.from(value, (character) => `U+${character.codePointAt(0).toString(16).toUpperCase()}`).join(" ");
}
