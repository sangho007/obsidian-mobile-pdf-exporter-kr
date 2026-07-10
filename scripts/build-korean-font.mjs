#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const sourcePath = resolve(process.argv[2] ?? "fonts/NotoSansCJKkr-VF.ttf");
const outputPath = resolve(
  process.argv[3] ?? "fonts/NotoSansCJKkr-Regular.ko-subset.ttf"
);
const expectedSourceSha256 = "7715af52f5fe77153ce5678546258993982d2da61abea8d25fb89eb5aaec5ca6";

const sourceBytes = readFileSync(sourcePath);
const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
if (sourceDigest !== expectedSourceSha256 && process.env.ALLOW_UNVERIFIED_FONT !== "1") {
  throw new Error(
    `Unexpected source font SHA-256 ${sourceDigest}. Expected ${expectedSourceSha256}. ` +
    "Set ALLOW_UNVERIFIED_FONT=1 only when intentionally rebuilding from another source."
  );
}

const codepoints = new Set();

function addRange(start, end) {
  for (let value = start; value <= end; value += 1) codepoints.add(value);
}

// Latin, combining marks, Greek, Cyrillic, punctuation, currency, arrows,
// common mathematical/technical symbols, shapes, dingbats, and full-width forms.
for (const [start, end] of [
  [0x0020, 0x024f],
  [0x0300, 0x036f],
  [0x0370, 0x052f],
  [0x2000, 0x206f],
  [0x20a0, 0x20cf],
  [0x2100, 0x23ff],
  [0x2460, 0x27bf],
  [0x2b00, 0x2bff],
  [0x3000, 0x303f],
  [0xff00, 0xffef],
  [0x1f100, 0x1f1ff]
]) {
  addRange(start, end);
}

// Modern and historic Hangul: jamo, compatibility jamo, extended jamo,
// and all 11,172 precomposed modern Hangul syllables.
for (const [start, end] of [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xd7b0, 0xd7ff]
]) {
  addRange(start, end);
}

function toUnicodeRanges(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const ranges = [];
  let start = sorted[0];
  let end = start;

  for (const value of sorted.slice(1)) {
    if (value === end + 1) {
      end = value;
      continue;
    }
    ranges.push(start === end ? start.toString(16) : `${start.toString(16)}-${end.toString(16)}`);
    start = value;
    end = value;
  }
  ranges.push(start === end ? start.toString(16) : `${start.toString(16)}-${end.toString(16)}`);
  return ranges.join(",");
}

const subset = spawnSync(
  "hb-subset",
  [
    `--unicodes=${toUnicodeRanges(codepoints)}`,
    "--variations=wght=400",
    "--layout-features=*",
    "--layout-scripts=*",
    "--name-IDs=*",
    "--name-languages=*",
    "--name-legacy",
    "--notdef-outline",
    "--glyph-names",
    "--no-hinting",
    `--output-file=${outputPath}`,
    sourcePath
  ],
  { encoding: "utf8" }
);

if (subset.status !== 0) {
  process.stderr.write(subset.stderr || subset.stdout || "hb-subset failed\n");
  process.exit(subset.status ?? 1);
}

const fontBytes = readFileSync(outputPath);
const gzipBytes = gzipSync(fontBytes, { level: 9 });
writeFileSync(`${outputPath}.gz`, gzipBytes);

const digest = createHash("sha256").update(fontBytes).digest("hex");
process.stdout.write(
  [
    `Built ${outputPath}`,
    `Source SHA-256: ${sourceDigest}`,
    `Unicode code points requested: ${codepoints.size}`,
    `Font bytes: ${fontBytes.byteLength}`,
    `Gzip bytes: ${gzipBytes.byteLength}`,
    `SHA-256: ${digest}`
  ].join("\n") + "\n"
);
