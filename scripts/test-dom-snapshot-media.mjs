#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const helperDir = mkdtempSync(`${tmpdir()}/mobile-pdf-dom-snapshot-media-`);
const bundlePath = resolve(helperDir, "dom-snapshot.mjs");

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.values = new Map();
    this.replacement = null;
  }

  get attributes() {
    return Array.from(this.values, ([name, value]) => ({ name, value }));
  }

  setAttribute(name, value) {
    this.values.set(name, String(value));
  }

  getAttribute(name) {
    return this.values.get(name) ?? null;
  }

  removeAttribute(name) {
    this.values.delete(name);
  }

  replaceWith(replacement) {
    this.replacement = replacement;
  }
}

try {
  await build({
    entryPoints: [resolve("src/dom-snapshot.ts")],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    platform: "node",
    target: "es2021",
    logLevel: "silent"
  });
  const { domSnapshotMediaTestApi: media } = await import(pathToFileURL(bundlePath).href);
  const random = xorshift32(0xd06b0d9e);

  assert.equal(media.getBase64DataUrlByteLength("data:image/png;base64,AA=="), 1);
  assert.equal(media.getBase64DataUrlByteLength("data:image/png;base64,AAAA"), 3);
  assert.equal(media.getBase64DataUrlByteLength("data:image/png,AAAA"), null);

  assert.equal(media.isGeometrySafe(1, 1), true);
  assert.equal(media.isGeometrySafe(media.limits.maxDimension + 1, 1), false);
  assert.equal(
    media.isGeometrySafe(media.limits.maxDimension, media.limits.maxDimension),
    false,
    "pixel cap must apply even within the dimension cap"
  );

  const characterBudget = media.createBudget();
  characterBudget.totalDataUrlChars = media.limits.maxTotalDataUrlChars - 4;
  const characterBudgetBefore = { ...characterBudget };
  assert.equal(media.reserveDataUrl("data:image/png;base64,AA==", characterBudget), false);
  assert.deepEqual(characterBudget, characterBudgetBefore, "a rejected reservation must not consume budget");

  const byteBudget = media.createBudget();
  byteBudget.totalBytes = media.limits.maxTotalBytes;
  assert.equal(media.reserveDataUrl("data:image/png;base64,AA==", byteBudget), false);

  const document = createFakeDocument();
  const brokenTarget = document.createElement("img");
  const brokenResult = await media.inlineMediaElement({
    tagName: "IMG",
    complete: false,
    naturalWidth: 0,
    naturalHeight: 0,
    alt: "깨진 이미지",
    currentSrc: "broken.png",
    src: "broken.png"
  }, brokenTarget, media.createBudget());
  assert.match(brokenResult, /^image:/u, "an unloaded image must force compatibility fallback");
  assert.equal(brokenTarget.replacement?.getAttribute("role"), "img");

  let dimensionCanvasCalls = 0;
  const oversizedDimensionCanvas = {
    tagName: "CANVAS",
    width: media.limits.maxDimension + 1,
    height: 1,
    toDataURL() {
      dimensionCanvasCalls += 1;
      return "data:image/png;base64,AA==";
    }
  };
  const dimensionResult = await media.inlineMediaElement(
    oversizedDimensionCanvas,
    document.createElement("canvas"),
    media.createBudget()
  );
  assert.equal(dimensionResult, "canvas");
  assert.equal(dimensionCanvasCalls, 0, "dimension guard must run before synchronous canvas.toDataURL");

  let pixelCanvasCalls = 0;
  const oversizedPixelCanvas = {
    tagName: "CANVAS",
    width: media.limits.maxDimension,
    height: media.limits.maxDimension,
    toDataURL() {
      pixelCanvasCalls += 1;
      return "data:image/png;base64,AA==";
    }
  };
  const pixelResult = await media.inlineMediaElement(
    oversizedPixelCanvas,
    document.createElement("canvas"),
    media.createBudget()
  );
  assert.equal(pixelResult, "canvas");
  assert.equal(pixelCanvasCalls, 0, "pixel guard must run before synchronous canvas.toDataURL");

  let safeToBlobCalls = 0;
  let safeToDataUrlCalls = 0;
  const safeCanvas = {
    tagName: "CANVAS",
    width: 100,
    height: 50,
    toBlob(callback) {
      safeToBlobCalls += 1;
      callback(new Blob([minimalPngBytes()], { type: "image/png" }));
    },
    toDataURL() {
      safeToDataUrlCalls += 1;
      throw new Error("the synchronous path must never be used");
    }
  };
  const safeTarget = document.createElement("canvas");
  const safeResult = await media.inlineMediaElement(safeCanvas, safeTarget, media.createBudget());
  assert.equal(safeResult, null);
  assert.equal(safeToBlobCalls, 1, "bounded canvas media must use asynchronous PNG encoding");
  assert.equal(safeToDataUrlCalls, 0, "DOM media must not create a synchronous data URL");
  assert.equal(safeTarget.replacement?.tagName, "IMG");

  let rejectedArrayBufferCalls = 0;
  const overBudgetCanvas = {
    tagName: "CANVAS",
    width: 100,
    height: 50,
    toBlob(callback) {
      callback({
        size: media.limits.maxItemBytes + 1,
        arrayBuffer() {
          rejectedArrayBufferCalls += 1;
          throw new Error("oversized media must be rejected before buffering");
        }
      });
    }
  };
  const overBudgetResult = await media.inlineMediaElement(
    overBudgetCanvas,
    document.createElement("canvas"),
    media.createBudget()
  );
  assert.equal(overBudgetResult, "canvas");
  assert.equal(rejectedArrayBufferCalls, 0, "encoded-size budget must run before byte/string allocation");

  let pendingBlobCallback = null;
  const abortController = new AbortController();
  const abortPromise = media.inlineMediaElement({
    tagName: "CANVAS",
    width: 100,
    height: 50,
    toBlob(callback) {
      pendingBlobCallback = callback;
    }
  }, document.createElement("canvas"), media.createBudget(), abortController.signal);
  abortController.abort();
  await assert.rejects(abortPromise, /cancelled/u, "preparation abort must interrupt a pending media encode");
  pendingBlobCallback?.(new Blob([minimalPngBytes()], { type: "image/png" }));

  for (let byteLength = 1; byteLength <= 4_096; byteLength += 1) {
    const dataUrl = base64DataUrlForBytes(byteLength);
    assert.equal(media.getBase64DataUrlByteLength(dataUrl), byteLength, `base64 length mismatch at ${byteLength} bytes`);
  }
  for (const invalidDataUrl of [
    "",
    "data:image/png,AAAA",
    "data:image/png;base64,",
    "data:image/png;base64,A",
    "data:image/png;base64,AA",
    "data:image/png;base64,AAA"
  ]) {
    assert.equal(media.getBase64DataUrlByteLength(invalidDataUrl), null);
    const budget = media.createBudget();
    const before = { ...budget };
    assert.equal(media.reserveDataUrl(invalidDataUrl, budget), false);
    assert.deepEqual(budget, before, "an invalid data URL must not mutate the cumulative budget");
  }

  const geometryBoundaryCases = [
    [1, 1],
    [media.limits.maxDimension, 1],
    [1, media.limits.maxDimension],
    [2_000, 1_000],
    [media.limits.maxDimension, Math.floor(media.limits.maxPixels / media.limits.maxDimension)],
    [media.limits.maxDimension + 1, 1],
    [1, media.limits.maxDimension + 1],
    [2_000, 1_001],
    [0, 1],
    [-1, 1],
    [1.5, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [Number.MAX_VALUE, 1]
  ];
  for (let index = 0; index < 5_000; index += 1) {
    const mode = index % 5;
    const width = mode === 0
      ? randomInteger(random, 1, media.limits.maxDimension * 2)
      : mode === 1 ? random() * media.limits.maxDimension * 2
        : mode === 2 ? randomChoice(random, [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
          : mode === 3 ? randomInteger(random, 1, media.limits.maxDimension)
            : Number.MAX_VALUE;
    const height = mode === 3
      ? random() * media.limits.maxDimension * 2
      : randomInteger(random, 1, media.limits.maxDimension * 2);
    geometryBoundaryCases.push([width, height]);
  }
  for (const [width, height] of geometryBoundaryCases) {
    const expected = Number.isFinite(width) && Number.isFinite(height) &&
      Number.isInteger(width) && Number.isInteger(height) &&
      width > 0 && height > 0 &&
      width <= media.limits.maxDimension && height <= media.limits.maxDimension &&
      width * height <= media.limits.maxPixels;
    assert.equal(media.isGeometrySafe(width, height), expected, `geometry decision mismatch for ${width} x ${height}`);
  }

  const imageRectCases = [
    { width: 1, height: 1, dpr: 1, succeeds: true },
    { width: 0, height: 0, dpr: 2, succeeds: true },
    { width: 1e9, height: 0.01, dpr: 2, succeeds: true },
    { width: 0.01, height: 1e9, dpr: 2, succeeds: true },
    { width: 1e9, height: 1e9, dpr: 2, succeeds: true },
    { width: Number.MAX_VALUE / 4, height: 1, dpr: 2, succeeds: true },
    { width: -1, height: 1, dpr: 1, succeeds: false },
    { width: 1, height: -1, dpr: 1, succeeds: false },
    { width: Number.NaN, height: 1, dpr: 1, succeeds: false },
    { width: Number.POSITIVE_INFINITY, height: 1, dpr: 1, succeeds: false }
  ];
  for (const testCase of imageRectCases) {
    const imageHarness = createImageRasterHarness(testCase.width, testCase.height, testCase.dpr);
    const target = document.createElement("img");
    const budget = media.createBudget();
    const result = await media.inlineMediaElement(imageHarness.image, target, budget);
    if (testCase.succeeds) {
      assert.equal(result, null, `finite image rect ${testCase.width} x ${testCase.height} should be bounded and rasterized`);
      assert.equal(imageHarness.canvases.length, 1);
      const raster = imageHarness.canvases[0];
      assert.ok(Number.isInteger(raster.width) && raster.width >= 1 && raster.width <= media.limits.maxDimension);
      assert.ok(Number.isInteger(raster.height) && raster.height >= 1 && raster.height <= media.limits.maxDimension);
      assert.ok(raster.width * raster.height <= media.limits.maxPixels);
      assert.equal(raster.drawCalls, 1);
      assert.equal(budget.count, 1);
    } else {
      assert.match(result, /^image:/u);
      assert.equal(imageHarness.canvases.length, 0, "invalid image geometry must fail before canvas allocation");
      assert.deepEqual(budget, media.createBudget());
    }
  }

  const countBudget = media.createBudget();
  const oneByteDataUrl = base64DataUrlForBytes(1);
  for (let count = 0; count < media.limits.maxCount; count += 1) {
    assert.equal(media.reserveDataUrl(oneByteDataUrl, countBudget), true, `reservation ${count + 1} should fit the count budget`);
  }
  assert.equal(countBudget.count, media.limits.maxCount);
  const countBeforeRejection = { ...countBudget };
  assert.equal(media.reserveDataUrl(oneByteDataUrl, countBudget), false);
  assert.deepEqual(countBudget, countBeforeRejection, "count-limit rejection must be atomic");

  const exactByteBudget = media.createBudget();
  exactByteBudget.totalBytes = media.limits.maxTotalBytes - 1;
  assert.equal(media.reserveDataUrl(oneByteDataUrl, exactByteBudget), true, "the exact total-byte boundary should be accepted");
  assert.equal(exactByteBudget.totalBytes, media.limits.maxTotalBytes);
  const exactByteBeforeRejection = { ...exactByteBudget };
  assert.equal(media.reserveDataUrl(oneByteDataUrl, exactByteBudget), false);
  assert.deepEqual(exactByteBudget, exactByteBeforeRejection, "byte-limit rejection must be atomic");

  const exactCharacterBudget = media.createBudget();
  exactCharacterBudget.totalDataUrlChars = media.limits.maxTotalDataUrlChars - oneByteDataUrl.length;
  assert.equal(media.reserveDataUrl(oneByteDataUrl, exactCharacterBudget), true, "the exact character boundary should be accepted");
  assert.equal(exactCharacterBudget.totalDataUrlChars, media.limits.maxTotalDataUrlChars);
  const exactCharacterBeforeRejection = { ...exactCharacterBudget };
  assert.equal(media.reserveDataUrl(oneByteDataUrl, exactCharacterBudget), false);
  assert.deepEqual(exactCharacterBudget, exactCharacterBeforeRejection, "character-limit rejection must be atomic");

  const oversizedItemDataUrl = base64DataUrlForBytes(media.limits.maxItemBytes + 1);
  const oversizedItemBudget = media.createBudget();
  const oversizedItemBefore = { ...oversizedItemBudget };
  assert.equal(media.reserveDataUrl(oversizedItemDataUrl, oversizedItemBudget), false);
  assert.deepEqual(oversizedItemBudget, oversizedItemBefore, "per-item rejection must not reserve partial totals");

  let exhaustedToBlobCalls = 0;
  const exhaustedBudget = media.createBudget();
  exhaustedBudget.count = media.limits.maxCount;
  const exhaustedResult = await media.inlineMediaElement({
    tagName: "CANVAS",
    width: 10,
    height: 10,
    toBlob() {
      exhaustedToBlobCalls += 1;
    }
  }, document.createElement("canvas"), exhaustedBudget);
  assert.equal(exhaustedResult, "canvas");
  assert.equal(exhaustedToBlobCalls, 0, "an exhausted budget must reject before starting PNG encoding");

  const invalidSignatureBudget = media.createBudget();
  const invalidSignatureBefore = { ...invalidSignatureBudget };
  const invalidSignatureResult = await media.inlineMediaElement({
    tagName: "CANVAS",
    width: 10,
    height: 10,
    toBlob(callback) {
      callback(new Blob([Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])], { type: "image/png" }));
    }
  }, document.createElement("canvas"), invalidSignatureBudget);
  assert.equal(invalidSignatureResult, "canvas");
  assert.deepEqual(invalidSignatureBudget, invalidSignatureBefore, "invalid PNG bytes must not consume budget");

  let preAbortedToBlobCalls = 0;
  const preAbortedController = new AbortController();
  preAbortedController.abort();
  const preAbortedBudget = media.createBudget();
  await assert.rejects(media.inlineMediaElement({
    tagName: "CANVAS",
    width: 10,
    height: 10,
    toBlob() {
      preAbortedToBlobCalls += 1;
    }
  }, document.createElement("canvas"), preAbortedBudget, preAbortedController.signal), /cancelled/u);
  assert.equal(preAbortedToBlobCalls, 0);
  assert.deepEqual(preAbortedBudget, media.createBudget(), "a pre-aborted encode must not reserve budget");

  let releaseAbortedArrayBuffer;
  let abortedArrayBufferCalls = 0;
  const arrayAbortController = new AbortController();
  const arrayAbortBudget = media.createBudget();
  const arrayAbortPromise = media.inlineMediaElement({
    tagName: "CANVAS",
    width: 10,
    height: 10,
    toBlob(callback) {
      callback({
        size: minimalPngBytes().byteLength,
        arrayBuffer() {
          abortedArrayBufferCalls += 1;
          return new Promise((resolveBuffer) => {
            releaseAbortedArrayBuffer = () => resolveBuffer(minimalPngBytes().buffer);
          });
        }
      });
    }
  }, document.createElement("canvas"), arrayAbortBudget, arrayAbortController.signal);
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(abortedArrayBufferCalls, 1);
  arrayAbortController.abort();
  releaseAbortedArrayBuffer();
  await assert.rejects(arrayAbortPromise, /cancelled/u, "abort during ArrayBuffer conversion must reject");
  assert.deepEqual(arrayAbortBudget, media.createBudget(), "abort during ArrayBuffer conversion must not reserve budget");

  const exactInlineBudget = media.createBudget();
  exactInlineBudget.totalBytes = media.limits.maxTotalBytes - minimalPngBytes().byteLength;
  const exactInlineResult = await media.inlineMediaElement({
    tagName: "CANVAS",
    width: 10,
    height: 10,
    toBlob(callback) {
      callback(new Blob([minimalPngBytes()], { type: "image/png" }));
    }
  }, document.createElement("canvas"), exactInlineBudget);
  assert.equal(exactInlineResult, null);
  assert.equal(exactInlineBudget.totalBytes, media.limits.maxTotalBytes, "inline encoding may fill the exact byte total");

  const concurrentBudget = media.createBudget();
  concurrentBudget.totalBytes = media.limits.maxTotalBytes - minimalPngBytes().byteLength;
  const releases = [];
  const concurrentCanvas = () => ({
    tagName: "CANVAS",
    width: 10,
    height: 10,
    toBlob(callback) {
      callback({
        size: minimalPngBytes().byteLength,
        arrayBuffer() {
          return new Promise((resolveBuffer) => {
            releases.push(() => resolveBuffer(minimalPngBytes().buffer));
          });
        }
      });
    }
  });
  const concurrentResultsPromise = Promise.all([
    media.inlineMediaElement(concurrentCanvas(), document.createElement("canvas"), concurrentBudget),
    media.inlineMediaElement(concurrentCanvas(), document.createElement("canvas"), concurrentBudget)
  ]);
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(releases.length, 2, "both concurrent encodes must reach the reservation race");
  for (const release of releases) release();
  const concurrentResults = await concurrentResultsPromise;
  assert.ok(
    concurrentBudget.totalBytes <= media.limits.maxTotalBytes &&
      concurrentBudget.totalDataUrlChars <= media.limits.maxTotalDataUrlChars &&
      concurrentBudget.count <= media.limits.maxCount,
    `concurrent reservations exceeded a cumulative cap: ${JSON.stringify(concurrentBudget)}`
  );
  assert.equal(concurrentResults.filter((result) => result === null).length, 1, "only one concurrent item may claim the final budget slot");

  const randomBoundaryValues = (limit) => [
    0,
    1,
    Math.max(0, limit - 1),
    limit,
    randomInteger(random, 0, limit)
  ];
  for (let iteration = 0; iteration < 5_000; iteration += 1) {
    const bytes = randomChoice(random, [1, 2, 3, 8, 9, 10, 127, 128, 255, 256, 4_095, 4_096]);
    const dataUrl = base64DataUrlForBytes(bytes);
    const modeledBudget = media.createBudget();
    modeledBudget.count = randomChoice(random, randomBoundaryValues(media.limits.maxCount));
    modeledBudget.totalBytes = randomChoice(random, randomBoundaryValues(media.limits.maxTotalBytes));
    modeledBudget.totalDataUrlChars = randomChoice(random, randomBoundaryValues(media.limits.maxTotalDataUrlChars));
    const before = { ...modeledBudget };
    const expected = before.count + 1 <= media.limits.maxCount &&
      before.totalBytes + bytes <= media.limits.maxTotalBytes &&
      before.totalDataUrlChars + dataUrl.length <= media.limits.maxTotalDataUrlChars &&
      bytes <= media.limits.maxItemBytes && dataUrl.length <= media.limits.maxItemDataUrlChars;
    assert.equal(media.reserveDataUrl(dataUrl, modeledBudget), expected, `modeled budget mismatch at iteration ${iteration}`);
    if (expected) {
      assert.deepEqual(modeledBudget, {
        count: before.count + 1,
        totalBytes: before.totalBytes + bytes,
        totalDataUrlChars: before.totalDataUrlChars + dataUrl.length
      });
    } else {
      assert.deepEqual(modeledBudget, before, `modeled rejection ${iteration} was not atomic`);
    }
  }

  const pngDataUrlLength = base64DataUrlForBytes(minimalPngBytes().byteLength).length;
  const concurrentCapCases = [
    {
      name: "count",
      budget: {
        count: media.limits.maxCount - 3,
        totalBytes: 0,
        totalDataUrlChars: 0
      }
    },
    {
      name: "bytes",
      budget: {
        count: 0,
        totalBytes: media.limits.maxTotalBytes - minimalPngBytes().byteLength * 3,
        totalDataUrlChars: 0
      }
    },
    {
      name: "characters",
      budget: {
        count: 0,
        totalBytes: 0,
        totalDataUrlChars: media.limits.maxTotalDataUrlChars - pngDataUrlLength * 3
      }
    }
  ];
  for (const testCase of concurrentCapCases) {
    const result = await runConcurrentCanvasEncodes(media, document, testCase.budget, 8);
    assert.equal(
      result.filter((item) => item === null).length,
      3,
      `exactly three concurrent encodes should fit the remaining ${testCase.name} budget`
    );
    assert.ok(testCase.budget.count <= media.limits.maxCount);
    assert.ok(testCase.budget.totalBytes <= media.limits.maxTotalBytes);
    assert.ok(testCase.budget.totalDataUrlChars <= media.limits.maxTotalDataUrlChars);
  }

  process.stdout.write(
    "Verified 4,096 base64 sizes, 5,014 hostile media geometries, 10 huge/invalid image rects, 5,000 modeled reservations, " +
    "async/abort races, exact byte/count/character caps, atomic rejection, and concurrent cumulative-budget safety.\n"
  );
} finally {
  rmSync(helperDir, { recursive: true, force: true });
}

function createFakeDocument() {
  const document = {
    createElement(tagName) {
      return new FakeElement(tagName, document);
    }
  };
  return document;
}

function minimalPngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

function base64DataUrlForBytes(byteLength) {
  assert.ok(Number.isSafeInteger(byteLength) && byteLength > 0);
  const payloadLength = Math.ceil(byteLength / 3) * 4;
  const padding = byteLength % 3 === 1 ? "==" : byteLength % 3 === 2 ? "=" : "";
  return `data:image/png;base64,${"A".repeat(payloadLength - padding.length)}${padding}`;
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

async function runConcurrentCanvasEncodes(media, document, budget, count) {
  const releases = [];
  const tasks = Array.from({ length: count }, () => media.inlineMediaElement({
    tagName: "CANVAS",
    width: 10,
    height: 10,
    toBlob(callback) {
      callback({
        size: minimalPngBytes().byteLength,
        arrayBuffer() {
          return new Promise((resolveBuffer) => {
            releases.push(() => resolveBuffer(minimalPngBytes().buffer));
          });
        }
      });
    }
  }, document.createElement("canvas"), budget));
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(releases.length, count);
  for (const release of releases) release();
  return Promise.all(tasks);
}

function createImageRasterHarness(rectWidth, rectHeight, devicePixelRatio) {
  const canvases = [];
  const ownerDocument = {
    defaultView: { devicePixelRatio },
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      const canvas = {
        width: 0,
        height: 0,
        drawCalls: 0,
        getContext(contextType) {
          assert.equal(contextType, "2d");
          return {
            imageSmoothingEnabled: false,
            imageSmoothingQuality: "low",
            drawImage() {
              canvas.drawCalls += 1;
            }
          };
        },
        toBlob(callback) {
          callback(new Blob([minimalPngBytes()], { type: "image/png" }));
        }
      };
      canvases.push(canvas);
      return canvas;
    }
  };
  return {
    canvases,
    image: {
      tagName: "IMG",
      complete: true,
      naturalWidth: 1,
      naturalHeight: 1,
      alt: "hostile rect",
      currentSrc: "data:image/png;base64,AA==",
      src: "data:image/png;base64,AA==",
      ownerDocument,
      getBoundingClientRect() {
        return { width: rectWidth, height: rectHeight };
      }
    }
  };
}
