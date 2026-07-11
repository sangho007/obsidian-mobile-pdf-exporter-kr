#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const helperDir = mkdtempSync(`${tmpdir()}/mobile-pdf-media-raster-`);
const bundlePath = resolve(helperDir, "media-raster.mjs");

try {
  await build({
    entryPoints: [resolve("src/media-raster.ts")],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    platform: "node",
    target: "es2021",
    logLevel: "silent"
  });
  const {
    canvasToPngBlob,
    canvasToPngBytes,
    getSafeDocumentRasterScale,
    getSafeRasterDimensions,
    hasPngSignature,
    readResponseBlobWithinLimit,
    rasterizeImageToPngBytes
  } = await import(pathToFileURL(bundlePath).href);
  const limits = { maxDimension: 3072, maxPixels: 4_000_000, maxPngBytes: 16 * 1024 * 1024 };
  const random = xorshift32(0x51a7e2d9);

  const fitted = getSafeRasterDimensions(12_000, 9_000, limits);
  assert.ok(fitted.width <= limits.maxDimension && fitted.height <= limits.maxDimension);
  assert.ok(fitted.width * fitted.height <= limits.maxPixels);
  assert.ok(fitted.width < 12_000 && fitted.height < 9_000, "large natural images must be downscaled");
  assert.ok(Math.abs(fitted.width / fitted.height - 4 / 3) < 0.002, "downscaling must preserve aspect ratio");

  const unchanged = getSafeRasterDimensions(800, 600, limits);
  assert.deepEqual(unchanged, { width: 800, height: 600, scale: 1 });

  const documentLimits = {
    maxDimension: 4096,
    maxPixelsPerPage: 12_000_000,
    maxTotalPixels: 20_000_000,
    minScale: 0.5,
    maxScale: 3
  };
  const fivePageScale = getSafeDocumentRasterScale(794, 1123, 5, 2, documentLimits);
  assert.equal(fivePageScale, 2, "a normal five-page selectable PDF should retain its requested 2x scale");
  const thirtyPageScale = getSafeDocumentRasterScale(794, 1123, 30, 2, documentLimits);
  assert.ok(thirtyPageScale > 0.5 && thirtyPageScale < 1, "a long PDF must reduce its retained RGB footprint");
  assert.ok(
    794 * 1123 * 30 * thirtyPageScale ** 2 <= documentLimits.maxTotalPixels * (1 + 1e-12),
    "the common document scale must respect the cumulative pixel budget"
  );
  assert.ok(
    Math.ceil(794 * thirtyPageScale) * Math.ceil(1123 * thirtyPageScale) * 30 <=
      documentLimits.maxTotalPixels,
    "ceil-rounded canvas dimensions must respect the cumulative pixel budget"
  );
  const hugePageScale = getSafeDocumentRasterScale(5000, 5000, 1, 3, documentLimits);
  assert.ok(hugePageScale <= Math.sqrt(documentLimits.maxPixelsPerPage / 25_000_000));
  assert.throws(
    () => getSafeDocumentRasterScale(794, 1123, 100, 2, documentLimits),
    /memory budget/u,
    "a document that cannot remain legible at the minimum scale must fail before allocating page PNGs"
  );
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => getSafeDocumentRasterScale(invalid, 1, 1, 1, documentLimits), /Invalid source width/u);
    assert.throws(() => getSafeDocumentRasterScale(1, invalid, 1, 1, documentLimits), /Invalid source height/u);
    assert.throws(() => getSafeDocumentRasterScale(1, 1, invalid, 1, documentLimits), /Invalid page count/u);
  }
  assert.throws(
    () => getSafeDocumentRasterScale(1, 1, 1, 1, { ...documentLimits, minScale: 2, maxScale: 1 }),
    /cannot exceed/u
  );

  const documentRandom = xorshift32(0xd0c5ca1e);
  let acceptedDocumentCases = 0;
  let rejectedDocumentCases = 0;
  let discreteBoundaryCases = 0;
  for (let iteration = 0; iteration < 5_000; iteration += 1) {
    const boundaryCase = iteration % 5 === 0;
    let sourceWidth;
    let sourceHeight;
    let rawPageCount;
    let requestedScale;
    let fuzzLimits;

    if (boundaryCase) {
      discreteBoundaryCases += 1;
      const boundaryScale = 0.05 + documentRandom() * 2.95;
      const targetWidth = randomInteger(documentRandom, 1, 4_096);
      const targetHeight = randomInteger(documentRandom, 1, 4_096);
      const widthOffset = randomChoice(documentRandom, [-1e-10, -Number.EPSILON, 0, Number.EPSILON, 1e-10]);
      const heightOffset = randomChoice(documentRandom, [-1e-10, -Number.EPSILON, 0, Number.EPSILON, 1e-10]);
      sourceWidth = Math.max(Number.MIN_VALUE, (targetWidth + widthOffset) / boundaryScale);
      sourceHeight = Math.max(Number.MIN_VALUE, (targetHeight + heightOffset) / boundaryScale);
      rawPageCount = randomInteger(documentRandom, 1, 240) + documentRandom();
      const pages = Math.max(1, Math.floor(rawPageCount));
      const roundedWidth = Math.max(1, Math.ceil(sourceWidth * boundaryScale));
      const roundedHeight = Math.max(1, Math.ceil(sourceHeight * boundaryScale));
      const pagePixels = roundedWidth * roundedHeight;
      const removePixel = iteration % 10 === 0 ? 1 : 0;
      fuzzLimits = {
        maxDimension: Math.max(roundedWidth, roundedHeight),
        maxPixelsPerPage: pagePixels,
        maxTotalPixels: Math.max(1, pagePixels * pages - removePixel),
        minScale: boundaryScale,
        maxScale: Math.min(4, boundaryScale + 0.25 + documentRandom())
      };
      requestedScale = randomChoice(documentRandom, [boundaryScale, fuzzLimits.maxScale, Number.NaN, Number.POSITIVE_INFINITY]);
    } else {
      sourceWidth = 10 ** (documentRandom() * 4.8) + documentRandom();
      sourceHeight = 10 ** (documentRandom() * 4.8) + documentRandom();
      rawPageCount = randomInteger(documentRandom, 1, 400) + documentRandom();
      const minScale = 0.02 + documentRandom() * 1.18;
      fuzzLimits = {
        maxDimension: randomInteger(documentRandom, 64, 8_192),
        maxPixelsPerPage: randomInteger(documentRandom, 4_096, 20_000_000),
        maxTotalPixels: randomInteger(documentRandom, 4_096, 250_000_000),
        minScale,
        maxScale: minScale + documentRandom() * (4 - minScale)
      };
      requestedScale = randomChoice(documentRandom, [
        -1,
        0,
        minScale,
        minScale + documentRandom() * (fuzzLimits.maxScale - minScale),
        fuzzLimits.maxScale + documentRandom() * 5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY
      ]);
    }

    const pages = Math.max(1, Math.floor(rawPageCount));
    const normalizedLimits = {
      maxDimension: Math.max(1, Math.floor(fuzzLimits.maxDimension)),
      maxPixelsPerPage: Math.max(1, Math.floor(fuzzLimits.maxPixelsPerPage)),
      maxTotalPixels: Math.max(1, Math.floor(fuzzLimits.maxTotalPixels)),
      minScale: fuzzLimits.minScale,
      maxScale: fuzzLimits.maxScale
    };
    const canvasAt = (scale) => {
      const width = Math.max(1, Math.ceil(sourceWidth * scale));
      const height = Math.max(1, Math.ceil(sourceHeight * scale));
      return { width, height, pagePixels: width * height };
    };
    const fits = (scale) => {
      const canvas = canvasAt(scale);
      return canvas.width <= normalizedLimits.maxDimension &&
        canvas.height <= normalizedLimits.maxDimension &&
        canvas.pagePixels <= normalizedLimits.maxPixelsPerPage &&
        canvas.pagePixels * pages <= normalizedLimits.maxTotalPixels;
    };
    const minimumFits = fits(normalizedLimits.minScale);
    let scale;
    let failure = null;
    try {
      scale = getSafeDocumentRasterScale(
        sourceWidth,
        sourceHeight,
        rawPageCount,
        requestedScale,
        fuzzLimits
      );
    } catch (error) {
      failure = error;
    }

    if (!minimumFits) {
      rejectedDocumentCases += 1;
      assert.match(
        String(failure),
        /memory budget/u,
        `case ${iteration} must reject when ceil-rounded minimum canvases exceed a cap`
      );
      continue;
    }
    acceptedDocumentCases += 1;
    assert.equal(failure, null, `case ${iteration} unexpectedly rejected: ${failure}`);
    assert.ok(Number.isFinite(scale), `case ${iteration} returned a non-finite scale`);
    assert.ok(scale >= normalizedLimits.minScale, `case ${iteration} fell below the configured legibility floor`);
    assert.ok(scale <= normalizedLimits.maxScale + 1e-12, `case ${iteration} exceeded maxScale`);
    assert.ok(fits(scale), `case ${iteration} exceeded an integer canvas budget at scale ${scale}`);

    const requested = Number.isFinite(requestedScale)
      ? Math.min(normalizedLimits.maxScale, Math.max(normalizedLimits.minScale, requestedScale))
      : normalizedLimits.minScale;
    const continuousLimit = Math.min(
      requested,
      normalizedLimits.maxDimension / sourceWidth,
      normalizedLimits.maxDimension / sourceHeight,
      Math.sqrt(normalizedLimits.maxPixelsPerPage / sourceWidth / sourceHeight),
      Math.sqrt(normalizedLimits.maxTotalPixels / sourceWidth / sourceHeight / pages)
    );
    assert.ok(scale <= continuousLimit + 1e-9, `case ${iteration} exceeded the continuous safety bound`);

    if (continuousLimit - scale > 1e-8) {
      const probe = scale + Math.min(1e-7, (continuousLimit - scale) / 2);
      assert.equal(
        fits(probe),
        false,
        `case ${iteration} left a nontrivial safe scale interval after binary search`
      );
    }
    assert.equal(
      getSafeDocumentRasterScale(sourceWidth, sourceHeight, rawPageCount, requestedScale, fuzzLimits),
      scale,
      `case ${iteration} was not deterministic`
    );
  }
  assert.ok(acceptedDocumentCases > 500, "document fuzz must exercise many successful scale selections");
  assert.ok(rejectedDocumentCases > 500, "document fuzz must exercise many minimum-scale rejections");
  assert.equal(discreteBoundaryCases, 1_000);

  let contentLengthReaderCalls = 0;
  let contentLengthReadCalls = 0;
  const advertisedOversizeResponse = {
    headers: new Headers({
      "content-length": "101",
      "content-type": "text/css"
    }),
    body: {
      getReader() {
        contentLengthReaderCalls += 1;
        return {
          read() {
            contentLengthReadCalls += 1;
            throw new Error("oversized Content-Length must reject before pulling the body");
          },
          cancel() {}
        };
      }
    }
  };
  await assert.rejects(
    readResponseBlobWithinLimit(advertisedOversizeResponse, 100),
    /Content-Length exceeds/u
  );
  assert.equal(contentLengthReaderCalls, 0, "oversized Content-Length must reject before acquiring a reader");
  assert.equal(contentLengthReadCalls, 0, "oversized Content-Length must not pull a response chunk");

  const exactChunks = [
    Uint8Array.from([1, 2, 3]),
    Uint8Array.from([4, 5]),
    Uint8Array.from([6, 7, 8, 9, 10])
  ];
  const exactResponse = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of exactChunks) controller.enqueue(chunk);
      controller.close();
    }
  }), {
    headers: {
      "content-length": "10",
      "content-type": "image/svg+xml;charset=utf-8"
    }
  });
  const exactBlob = await readResponseBlobWithinLimit(exactResponse, 10);
  assert.equal(exactBlob.size, 10, "the exact streamed byte boundary must be accepted");
  assert.equal(exactBlob.type, "image/svg+xml;charset=utf-8", "response MIME type must survive bounded streaming");
  assert.deepEqual(
    Array.from(new Uint8Array(await exactBlob.arrayBuffer())),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );

  let overflowReads = 0;
  let overflowCancels = 0;
  const overflowChunks = [new Uint8Array(60), new Uint8Array(41), new Uint8Array(1)];
  const chunkedOverflowResponse = {
    headers: new Headers({ "content-type": "application/octet-stream" }),
    body: {
      getReader() {
        return {
          async read() {
            const value = overflowChunks[overflowReads++];
            return value ? { done: false, value } : { done: true, value: undefined };
          },
          async cancel() {
            overflowCancels += 1;
          }
        };
      }
    }
  };
  await assert.rejects(
    readResponseBlobWithinLimit(chunkedOverflowResponse, 100),
    /body exceeds.*101 bytes/u
  );
  assert.equal(overflowReads, 2, "chunked overflow must stop on the first byte beyond the cap");
  assert.equal(overflowCancels, 1, "chunked overflow must cancel the network reader exactly once");

  const preAbortedResponseController = new AbortController();
  preAbortedResponseController.abort();
  let preAbortedResponseReaderCalls = 0;
  await assert.rejects(readResponseBlobWithinLimit({
    headers: new Headers(),
    body: {
      getReader() {
        preAbortedResponseReaderCalls += 1;
        throw new Error("pre-aborted reads must not acquire a reader");
      }
    }
  }, 100, preAbortedResponseController.signal), /aborted/u);
  assert.equal(preAbortedResponseReaderCalls, 0);

  let pendingResponseRead;
  let pendingResponseCancels = 0;
  const midReadAbortController = new AbortController();
  const pendingResponse = {
    headers: new Headers({ "content-type": "font/woff2" }),
    body: {
      getReader() {
        return {
          read() {
            return new Promise((resolveRead) => {
              pendingResponseRead = resolveRead;
            });
          },
          async cancel() {
            pendingResponseCancels += 1;
            pendingResponseRead?.({ done: true, value: undefined });
          }
        };
      }
    }
  };
  const abortedResponseRead = readResponseBlobWithinLimit(
    pendingResponse,
    100,
    midReadAbortController.signal
  );
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(typeof pendingResponseRead, "function", "abort test must reach a pending reader.read call");
  midReadAbortController.abort();
  await assert.rejects(abortedResponseRead, /aborted/u);
  assert.equal(pendingResponseCancels, 1, "abort must cancel a pending network reader exactly once");

  let nonSettlingCancelCalls = 0;
  const nonSettlingCancelRead = readResponseBlobWithinLimit({
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            throw new Error("hostile response read failure");
          },
          cancel() {
            nonSettlingCancelCalls += 1;
            return new Promise(() => {});
          }
        };
      }
    }
  }, 100);
  await assert.rejects(
    Promise.race([
      nonSettlingCancelRead,
      new Promise((_resolve, reject) => setTimeout(
        () => reject(new Error("non-settling cancel blocked response rejection")),
        100
      ))
    ]),
    /hostile response read failure/u
  );
  assert.equal(nonSettlingCancelCalls, 1, "a hanging reader.cancel must be attempted without blocking rejection");

  const calls = { draw: [], toBlob: 0, toDataUrl: 0 };
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage(...args) {
          calls.draw.push(args);
        }
      };
    },
    toBlob(callback) {
      calls.toBlob += 1;
      callback(new Blob([minimalPngBytes()], { type: "image/png" }));
    },
    toDataURL() {
      calls.toDataUrl += 1;
      throw new Error("compatibility image encoding must not use toDataURL");
    }
  };
  const image = {
    naturalWidth: 12_000,
    naturalHeight: 9_000,
    width: 12_000,
    height: 9_000,
    ownerDocument: {
      createElement(tagName) {
        assert.equal(tagName, "canvas");
        return canvas;
      }
    }
  };
  const bytes = await rasterizeImageToPngBytes(image, limits);
  assert.deepEqual(Array.from(bytes), Array.from(minimalPngBytes()));
  assert.equal(canvas.width, fitted.width);
  assert.equal(canvas.height, fitted.height);
  assert.deepEqual(calls.draw[0].slice(1), [0, 0, fitted.width, fitted.height]);
  assert.equal(calls.toBlob, 1, "compatibility images must use asynchronous PNG encoding");
  assert.equal(calls.toDataUrl, 0, "compatibility images must never allocate a base64 data URL");

  let oversizedArrayBufferCalls = 0;
  await assert.rejects(
    canvasToPngBytes({
      toBlob(callback) {
        callback({
          size: 101,
          arrayBuffer() {
            oversizedArrayBufferCalls += 1;
            throw new Error("oversized PNG must be rejected first");
          }
        });
      }
    }, 100),
    /encoded-size limit/u
  );
  assert.equal(oversizedArrayBufferCalls, 0, "PNG byte cap must run before ArrayBuffer allocation");

  const adversarialDimensions = [
    [1, 1],
    [Number.MIN_VALUE, Number.MIN_VALUE],
    [Number.MAX_SAFE_INTEGER, 1],
    [1, Number.MAX_SAFE_INTEGER],
    [Number.MAX_VALUE, 1],
    [1, Number.MAX_VALUE],
    [Number.MAX_VALUE, Number.MAX_VALUE],
    [1e300, 1e-300],
    [1e-300, 1e300],
    [limits.maxDimension, limits.maxDimension],
    [limits.maxDimension + 1, 1],
    [1, limits.maxDimension + 1]
  ];
  for (let index = 0; index < 4_096; index += 1) {
    const exponentWidth = random() * 308;
    const exponentHeight = random() * 308;
    adversarialDimensions.push([10 ** exponentWidth, 10 ** exponentHeight]);
  }
  for (const [sourceWidth, sourceHeight] of adversarialDimensions) {
    const dimensions = getSafeRasterDimensions(sourceWidth, sourceHeight, limits);
    const normalizedWidth = Math.max(1, Math.floor(sourceWidth));
    const normalizedHeight = Math.max(1, Math.floor(sourceHeight));
    assert.ok(Number.isSafeInteger(dimensions.width) && dimensions.width >= 1);
    assert.ok(Number.isSafeInteger(dimensions.height) && dimensions.height >= 1);
    assert.ok(dimensions.width <= limits.maxDimension && dimensions.height <= limits.maxDimension);
    assert.ok(dimensions.width * dimensions.height <= limits.maxPixels);
    assert.ok(dimensions.width <= normalizedWidth && dimensions.height <= normalizedHeight, "bounded rasterization must not upscale");
    assert.equal(dimensions.scale, Math.min(dimensions.width / normalizedWidth, dimensions.height / normalizedHeight));
    if (dimensions.width > 1 && dimensions.height > 1) {
      const widthScale = dimensions.width / normalizedWidth;
      const heightScale = dimensions.height / normalizedHeight;
      const quantizationBound = 1 / normalizedWidth + 1 / normalizedHeight;
      assert.ok(
        Math.abs(widthScale - heightScale) <= quantizationBound * 1.000001,
        `integer downscaling distorted aspect ratio for ${sourceWidth} x ${sourceHeight}`
      );
    }
  }

  for (const invalid of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => getSafeRasterDimensions(invalid, 1, limits), /Invalid source width/u);
    assert.throws(() => getSafeRasterDimensions(1, invalid, limits), /Invalid source height/u);
    assert.throws(
      () => getSafeRasterDimensions(1, 1, { ...limits, maxDimension: invalid }),
      /Invalid maximum dimension/u
    );
    assert.throws(
      () => getSafeRasterDimensions(1, 1, { ...limits, maxPixels: invalid }),
      /Invalid maximum pixels/u
    );
  }

  assert.equal(hasPngSignature(minimalPngBytes()), true);
  assert.equal(hasPngSignature(Uint8Array.from(minimalPngBytes().slice(0, 8))), false, "a signature without PNG payload is invalid");
  for (let index = 0; index < 8; index += 1) {
    const corrupted = minimalPngBytes();
    corrupted[index] ^= 0xff;
    assert.equal(hasPngSignature(corrupted), false, `signature byte ${index} must be checked`);
  }

  let invalidLimitToBlobCalls = 0;
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assert.rejects(canvasToPngBytes({
      toBlob() {
        invalidLimitToBlobCalls += 1;
      }
    }, invalid), /Invalid maximum PNG bytes/u);
  }
  assert.equal(invalidLimitToBlobCalls, 0, "invalid byte limits must fail before starting an encode");

  const exactBytes = await canvasToPngBytes({
    toBlob(callback) {
      callback(new Blob([minimalPngBytes()], { type: "image/png" }));
    }
  }, minimalPngBytes().byteLength);
  assert.deepEqual(Array.from(exactBytes), Array.from(minimalPngBytes()), "the exact encoded byte cap must be accepted");
  await assert.rejects(canvasToPngBytes({
    toBlob(callback) {
      callback(new Blob([minimalPngBytes()], { type: "image/png" }));
    }
  }, minimalPngBytes().byteLength - 1), /encoded-size limit/u);
  await assert.rejects(canvasToPngBytes({
    toBlob(callback) {
      callback(new Blob([Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])], { type: "image/png" }));
    }
  }, 100), /invalid PNG/u);
  await assert.rejects(canvasToPngBlob({ toBlob(callback) { callback(null); } }), /empty PNG/u);
  await assert.rejects(canvasToPngBlob({ toBlob() { throw new Error("synchronous encoder failure"); } }), /synchronous encoder failure/u);

  const preAborted = new AbortController();
  preAborted.abort();
  let preAbortedCalls = 0;
  await assert.rejects(canvasToPngBlob({
    toBlob() {
      preAbortedCalls += 1;
    }
  }, preAborted.signal), /aborted/u);
  assert.equal(preAbortedCalls, 0, "a pre-aborted request must not call the encoder");

  let pendingCallback;
  const pendingAbort = new AbortController();
  const pendingEncode = canvasToPngBytes({
    toBlob(callback) {
      pendingCallback = callback;
    }
  }, 100, pendingAbort.signal);
  pendingAbort.abort();
  pendingCallback(new Blob([minimalPngBytes()], { type: "image/png" }));
  await assert.rejects(pendingEncode, /aborted/u, "abort must win a race against a late toBlob callback");

  let postBlobArrayBufferCalls = 0;
  const postBlobAbort = new AbortController();
  const postBlobEncode = canvasToPngBytes({
    toBlob(callback) {
      callback({
        size: minimalPngBytes().byteLength,
        arrayBuffer() {
          postBlobArrayBufferCalls += 1;
          return Promise.resolve(minimalPngBytes().buffer);
        }
      });
    }
  }, 100, postBlobAbort.signal);
  postBlobAbort.abort();
  await assert.rejects(postBlobEncode, /aborted/u);
  assert.equal(
    postBlobArrayBufferCalls,
    0,
    "abort after toBlob but before its await continuation must prevent ArrayBuffer allocation"
  );

  let releaseArrayBuffer;
  let arrayBufferCalls = 0;
  const bufferAbort = new AbortController();
  const bufferEncode = canvasToPngBytes({
    toBlob(callback) {
      callback({
        size: minimalPngBytes().byteLength,
        arrayBuffer() {
          arrayBufferCalls += 1;
          return new Promise((resolveBuffer) => {
            releaseArrayBuffer = () => resolveBuffer(minimalPngBytes().buffer);
          });
        }
      });
    }
  }, 100, bufferAbort.signal);
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(arrayBufferCalls, 1);
  bufferAbort.abort();
  releaseArrayBuffer();
  await assert.rejects(bufferEncode, /aborted/u, "abort after Blob creation must be observed after buffer conversion");

  let duplicateCallback;
  const firstCallbackWins = canvasToPngBlob({
    toBlob(callback) {
      duplicateCallback = callback;
      callback(new Blob([minimalPngBytes()], { type: "image/png" }));
      callback(null);
    }
  });
  assert.equal((await firstCallbackWins).size, minimalPngBytes().byteLength, "only the first encoder callback may settle the promise");
  duplicateCallback?.(null);

  let postProcessCalls = 0;
  const processedBytes = await rasterizeImageToPngBytes(image, limits, (context, width, height) => {
    postProcessCalls += 1;
    assert.equal(context.imageSmoothingEnabled, true);
    assert.equal(width, fitted.width);
    assert.equal(height, fitted.height);
  });
  assert.deepEqual(Array.from(processedBytes), Array.from(minimalPngBytes()));
  assert.equal(postProcessCalls, 1, "post-processing must run once on the bounded raster");

  process.stdout.write(
    `Verified bounded response streaming (Content-Length, exact MIME boundary, chunk overflow, abort, hostile cancel), ` +
    `5,000 document-scale cases (${acceptedDocumentCases} accepted, ${rejectedDocumentCases} rejected, ` +
    `${discreteBoundaryCases} ceil boundaries), 4,108 huge/thin raster geometries, invalid numeric inputs, aspect preservation, ` +
    "async PNG byte caps, signature rejection, callback/abort races, and bounded post-processing.\n"
  );
} finally {
  rmSync(helperDir, { recursive: true, force: true });
}

function minimalPngBytes() {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
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
