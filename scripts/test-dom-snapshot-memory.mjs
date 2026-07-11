#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const helperDir = mkdtempSync(`${tmpdir()}/mobile-pdf-dom-snapshot-memory-`);
const bundlePath = resolve(helperDir, "dom-snapshot-memory.mjs");

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
  const { domSnapshotMemoryTestApi: memory } = await import(pathToFileURL(bundlePath).href);

  const customPropertyStyle = fakeStyle([
    ["--bomb", "x".repeat(1024 * 1024)],
    ["color", "rgb(1, 2, 3)"]
  ]);
  assert.equal(
    await memory.serializeStyle(customPropertyStyle),
    "color:rgb(1, 2, 3);",
    "inherited custom properties must not be copied into every frozen descendant style"
  );

  const property = "background-color";
  const exactValue = "x".repeat(memory.limits.maxStyleChars - property.length - 2);
  assert.equal(
    (await memory.serializeStyle(fakeStyle([[property, exactValue]]))).length,
    memory.limits.maxStyleChars,
    "the exact per-style character boundary must be accepted"
  );
  await assert.rejects(
    memory.serializeStyle(fakeStyle([[property, `${exactValue}x`]])),
    /computed style exceeds/u,
    "one character beyond the per-style boundary must reject"
  );

  const retained = memory.createBudget();
  retained.retainedChars = memory.limits.maxSourceChars - 1;
  memory.reserveChars(retained, 1);
  assert.equal(retained.retainedChars, memory.limits.maxSourceChars);
  for (const invalid of [1, -1, Number.NaN]) {
    const before = retained.retainedChars;
    assert.throws(() => memory.reserveChars(retained, invalid), /styles exceed/u);
    assert.equal(retained.retainedChars, before, "a rejected reservation must be atomic");
  }

  let attributeOverflowWalkerCalls = 0;
  const exactAttributeValueLength = memory.limits.maxSourceChars - 32 - "x".length - 4;
  const exactAttributeElement = fakeElement([["x", "a".repeat(exactAttributeValueLength)]], () => {
    attributeOverflowWalkerCalls += 1;
    return emptyWalker();
  });
  memory.assertSourceWithinBudget(exactAttributeElement, [exactAttributeElement]);
  assert.equal(attributeOverflowWalkerCalls, 1, "the exact source boundary must reach the content walker");

  attributeOverflowWalkerCalls = 0;
  const overflowAttributeElement = fakeElement([["x", "a".repeat(exactAttributeValueLength + 1)]], () => {
    attributeOverflowWalkerCalls += 1;
    return emptyWalker();
  });
  assert.throws(
    () => memory.assertSourceWithinBudget(overflowAttributeElement, [overflowAttributeElement]),
    /source exceeds/u
  );
  assert.equal(attributeOverflowWalkerCalls, 0, "attribute overflow must reject before traversing content nodes");

  let observedContentMask = 0;
  const exactContentElement = fakeElement([], (_root, mask) => {
    observedContentMask = mask;
    return valueWalker(["b".repeat(memory.limits.maxSourceChars - 32)]);
  });
  memory.assertSourceWithinBudget(exactContentElement, [exactContentElement]);
  assert.equal(observedContentMask, 4 | 128, "source preflight must count both text and comment nodes");

  const exactCountElement = fakeElement([], () => countingWalker(memory.limits.maxContentNodes));
  memory.assertSourceWithinBudget(exactCountElement, [exactCountElement]);
  const overflowCountElement = fakeElement([], () => countingWalker(memory.limits.maxContentNodes + 1));
  assert.throws(
    () => memory.assertSourceWithinBudget(overflowCountElement, [overflowCountElement]),
    /too many text\/comment nodes/u
  );

  const removed = [];
  const comments = Array.from({ length: 3 }, (_value, index) => ({
    nodeValue: `comment-${index}`,
    parentNode: { removeChild(node) { removed.push(node); } }
  }));
  let observedCommentMask = 0;
  const commentRoot = fakeElement([], (_root, mask) => {
    observedCommentMask = mask;
    return nodeWalker(comments);
  });
  memory.removeComments(commentRoot);
  assert.equal(observedCommentMask, 128, "comment removal must request only comment nodes");
  assert.deepEqual(removed, comments, "every cloned comment must be removed exactly once");

  process.stdout.write(
    "Verified custom-property elision, exact 64 KiB style and 8M retained/source caps, " +
    "20,000 content-node boundary, atomic rejection, and cloned-comment removal.\n"
  );
} finally {
  rmSync(helperDir, { recursive: true, force: true });
}

function fakeStyle(entries) {
  const values = new Map(entries);
  const properties = entries.map(([property]) => property);
  return {
    length: properties.length,
    item(index) { return properties[index] ?? ""; },
    getPropertyValue(property) { return values.get(property) ?? ""; },
    getPropertyPriority() { return ""; }
  };
}

function fakeElement(attributes, createTreeWalker) {
  return {
    attributes: attributes.map(([name, value]) => ({ name, value })),
    ownerDocument: { createTreeWalker }
  };
}

function emptyWalker() {
  return { currentNode: null, nextNode() { return false; } };
}

function valueWalker(values) {
  return nodeWalker(values.map((nodeValue) => ({ nodeValue })));
}

function nodeWalker(nodes) {
  let index = -1;
  return {
    currentNode: null,
    nextNode() {
      index += 1;
      if (index >= nodes.length) return false;
      this.currentNode = nodes[index];
      return true;
    }
  };
}

function countingWalker(count) {
  let index = 0;
  return {
    currentNode: { nodeValue: "" },
    nextNode() {
      index += 1;
      return index <= count;
    }
  };
}
