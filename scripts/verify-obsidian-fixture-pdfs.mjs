#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

if (process.argv[2] === "--self-test") {
  runVerifierSelfTests();
  process.exit(0);
}

const vaultPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node scripts/verify-obsidian-fixture-pdfs.mjs TEST_VAULT");
const pdfDir = resolve(vaultPath, "PDF Exports");
const pdftotext = process.env.PDFTOTEXT ?? "pdftotext";
const popplerDir = pdftotext.includes("/") ? dirname(pdftotext) : "";
const pdfinfo = process.env.PDFINFO ?? (popplerDir ? resolve(popplerDir, "pdfinfo") : "pdfinfo");
const pdffonts = process.env.PDFFONTS ?? (popplerDir ? resolve(popplerDir, "pdffonts") : "pdffonts");
const pdftoppm = process.env.PDFTOPPM ?? (popplerDir ? resolve(popplerDir, "pdftoppm") : "pdftoppm");
const renderDir = resolve("tmp/pdfs/obsidian-e2e");
mkdirSync(renderDir, { recursive: true });

const cases = [
  {
    name: "01-inline-korean",
    sentinels: ["INLINE_SENTINEL_END"],
    requiredText: ["인라인 공백: 한글 선택"],
    minimumPages: 1
  },
  {
    name: "02-table-code",
    sentinels: ["TABLE_CODE_SENTINEL_END"],
    requiredLayoutPatterns: [
      { label: "two and four consecutive code spaces", pattern: /연속 {2}공백과 {4}들여쓰기/u }
    ],
    relativeLayoutIndents: [
      { base: "function PDF_내보내기", nested: "const message", minimumExtraColumns: 4 }
    ],
    minimumPages: 1
  },
  { name: "03-callouts-lists", sentinels: ["CALLOUT_LIST_SENTINEL_END"], minimumPages: 1 },
  { name: "04-media-svg", sentinels: ["MEDIA_SENTINEL_END", "SVG_SENTINEL"], minimumPages: 1 },
  {
    name: "05-pagination",
    sentinels: [
      "PAGE_SENTINEL_01", "PAGE_SENTINEL_02", "PAGE_SENTINEL_03", "PAGE_SENTINEL_04",
      "PAGE_CODE_SENTINEL_BEGIN", "PAGE_CODE_SENTINEL_END", "PAGE_SENTINEL_05",
      "PAGE_SENTINEL_06", "PAGE_SENTINEL_END"
    ],
    minimumPages: 2
  },
  {
    name: "06-adversarial-text",
    sentinels: ["TEXT_ADV_SENTINEL_START", "TEXT_DIRECTION_SENTINEL", "TEXT_ADV_SENTINEL_END"],
    requiredText: ["굵은한글 기울임한글 표시한글", "NFD:", "옛한글:"],
    requiredLayoutPatterns: [
      { label: "eight consecutive code spaces", pattern: /연속 {8}공백과/u }
    ],
    relativeLayoutIndents: [
      { base: "첫째 줄", nested: "공백 네 칸", minimumExtraColumns: 4 },
      { base: "첫째 줄", nested: "탭 한 칸 뒤 한글", minimumExtraColumns: 2 }
    ],
    minimumPages: 2,
    maximumPages: 8
  },
  {
    name: "07-complex-layout",
    sentinels: [
      "COMPLEX_LAYOUT_SENTINEL_START", "COMPLEX_TABLE_SENTINEL", "COMPLEX_LAYOUT_SENTINEL_END"
    ],
    requiredText: ["바깥 경고", "안쪽 팁", "병합 행", "대형 SVG 다운스케일"],
    minimumPages: 2,
    maximumPages: 8
  },
  {
    name: "08-long-stress",
    sentinels: [
      "LONG_STRESS_SENTINEL_START",
      ...Array.from({ length: 12 }, (_value, index) => `LONG_STRESS_SECTION_${String(index + 1).padStart(2, "0")}`),
      "LONG_STRESS_SENTINEL_END"
    ],
    requiredText: ["장문 다중 페이지 스트레스", "페이지 경계 직전·직후에도"],
    minimumPages: 8,
    maximumPages: 30
  }
];

for (const fixture of cases) {
  const pdfPath = resolve(pdfDir, `${fixture.name}.pdf`);
  if (!existsSync(pdfPath)) throw new Error(`Missing exported fixture PDF: ${pdfPath}`);
  const pdfBytes = statSync(pdfPath).size;
  if (pdfBytes < 1_000 || pdfBytes > 100 * 1024 * 1024) {
    throw new Error(`${fixture.name}: suspicious PDF size ${pdfBytes} bytes.`);
  }
  const rawText = run(pdftotext, ["-enc", "UTF-8", "-raw", pdfPath, "-"]);
  const layoutText = run(pdftotext, ["-enc", "UTF-8", "-layout", pdfPath, "-"]);
  const normalizedRawText = rawText.replace(/[\s\u00A0]+/gu, " ").trim();
  for (const requiredText of fixture.requiredText ?? []) {
    if (!normalizedRawText.includes(requiredText)) {
      throw new Error(`${fixture.name}: missing selectable text phrase '${requiredText}'.\n${normalizedRawText}`);
    }
  }
  for (const requirement of fixture.requiredLayoutPatterns ?? []) {
    if (!requirement.pattern.test(layoutText)) {
      throw new Error(`${fixture.name}: missing preserved ${requirement.label} in selectable layout text.`);
    }
  }
  for (const requirement of fixture.relativeLayoutIndents ?? []) {
    assertRelativeLayoutIndent(layoutText, fixture.name, requirement);
  }
  for (const sentinel of fixture.sentinels) {
    const rawCount = countOccurrences(rawText, sentinel);
    const layoutCount = countOccurrences(layoutText, sentinel);
    if (rawCount !== 1 || layoutCount !== 1) {
      throw new Error(`${fixture.name}: ${sentinel} expected once (raw=${rawCount}, layout=${layoutCount}).`);
    }
  }
  const sentinelPositions = fixture.sentinels.map((sentinel) => rawText.indexOf(sentinel));
  for (let index = 1; index < sentinelPositions.length; index += 1) {
    if (sentinelPositions[index] <= sentinelPositions[index - 1]) {
      throw new Error(`${fixture.name}: sentinel order regressed near ${fixture.sentinels[index]}.`);
    }
  }

  const info = run(pdfinfo, [pdfPath]);
  const pageMatch = info.match(/^Pages:\s+(\d+)/mu);
  const pageCount = pageMatch ? Number(pageMatch[1]) : 0;
  if (pageCount < fixture.minimumPages) {
    throw new Error(`${fixture.name}: expected at least ${fixture.minimumPages} pages, received ${pageCount}.`);
  }
  if (fixture.maximumPages && pageCount > fixture.maximumPages) {
    throw new Error(`${fixture.name}: page count exploded (${pageCount} > ${fixture.maximumPages}).`);
  }
  const sizeMatch = info.match(/^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/mu);
  const pageWidth = Number(sizeMatch?.[1] ?? 0);
  const pageHeight = Number(sizeMatch?.[2] ?? 0);
  if (Math.abs(pageWidth - 595.28) > 1 || Math.abs(pageHeight - 841.89) > 1) {
    throw new Error(`${fixture.name}: expected A4 portrait pages, received ${pageWidth} x ${pageHeight} pt.`);
  }
  const perPageText = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const pageText = run(pdftotext, ["-enc", "UTF-8", "-f", String(page), "-l", String(page), pdfPath, "-"]);
    if (!pageText.replace(/[\s\u00A0]+/gu, "")) {
      throw new Error(`${fixture.name}: page ${page} has no selectable text.`);
    }
    perPageText.push(pageText);
  }
  for (const sentinel of fixture.sentinels) {
    const containingPages = perPageText.filter((pageText) => pageText.includes(sentinel)).length;
    if (containingPages !== 1) throw new Error(`${fixture.name}: ${sentinel} appears on ${containingPages} pages.`);
  }

  const fonts = run(pdffonts, [pdfPath]);
  const notoRow = fonts.split(/\r?\n/u).find((line) => /NotoSansCJKkr/iu.test(line));
  if (!notoRow || !/CID\s+TrueType/iu.test(notoRow) || !/\byes\s+yes\s+yes\b/iu.test(notoRow)) {
    throw new Error(`${fixture.name}: missing embedded subsetted Noto CID TrueType with ToUnicode.\n${fonts}`);
  }

  const analysisPrefix = `${fixture.name}-analysis`;
  for (const file of readdirSync(renderDir)) {
    if (file.startsWith(`${analysisPrefix}-`) && file.endsWith(".ppm")) rmSync(resolve(renderDir, file));
  }
  run(pdftoppm, ["-ppm", "-r", "36", pdfPath, resolve(renderDir, analysisPrefix)]);
  const renderedPages = readdirSync(renderDir)
    .map((file) => ({ file, match: file.match(new RegExp(`^${analysisPrefix}-(\\d+)\\.ppm$`, "u")) }))
    .filter((entry) => entry.match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  if (renderedPages.length !== pageCount) {
    throw new Error(`${fixture.name}: rendered ${renderedPages.length} low-resolution pages, expected ${pageCount}.`);
  }
  const pageDigests = new Set();
  const analyzedPages = [];
  for (const [index, entry] of renderedPages.entries()) {
    const metrics = inspectPpmPage(readFileSync(resolve(renderDir, entry.file)));
    if (metrics.dynamicRange < 8 || metrics.nonBackgroundPixels < 80) {
      throw new Error(
        `${fixture.name}: rendered page ${index + 1} looks blank/uniform ` +
        `(range=${metrics.dynamicRange}, foreground=${metrics.nonBackgroundPixels}).`
      );
    }
    if (pageDigests.has(metrics.pixelDigest)) {
      throw new Error(`${fixture.name}: rendered page ${index + 1} exactly duplicates an earlier page.`);
    }
    pageDigests.add(metrics.pixelDigest);
    analyzedPages.push(metrics);
  }
  for (let index = 1; index < analyzedPages.length; index += 1) {
    const overlapRows = findExactVerticalPageOverlap(analyzedPages[index - 1], analyzedPages[index]);
    if (overlapRows > 0) {
      throw new Error(
        `${fixture.name}: pages ${index} and ${index + 1} repeat ${overlapRows} rendered row(s) ` +
        "across their page boundary."
      );
    }
  }

  run(pdftoppm, ["-png", "-r", "120", pdfPath, resolve(renderDir, fixture.name)]);
  process.stdout.write(
    `${basename(pdfPath)}: ${pageCount} page(s), ordered sentinels/text/font/A4/nonblank pages verified.\n`
  );
}

process.stdout.write(`Verified ${cases.length} Obsidian fixture PDFs. Rendered pages: ${renderDir}\n`);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0 || result.signal) {
    throw new Error(`${command} failed with status ${result.status ?? "null"}.\n${result.stderr || result.stdout || ""}`);
  }
  if (result.stderr?.trim()) throw new Error(`${command} reported a warning:\n${result.stderr}`);
  return result.stdout;
}

function countOccurrences(text, value) {
  return text.split(value).length - 1;
}

function assertRelativeLayoutIndent(layoutText, fixtureName, requirement) {
  const lines = layoutText.split(/\r?\n/u);
  const baseLine = lines.find((line) => line.includes(requirement.base));
  const nestedLine = lines.find((line) => line.includes(requirement.nested));
  if (!baseLine || !nestedLine) {
    throw new Error(
      `${fixtureName}: could not locate layout indent pair '${requirement.base}' / '${requirement.nested}'.`
    );
  }
  const baseColumn = baseLine.indexOf(requirement.base);
  const nestedColumn = nestedLine.indexOf(requirement.nested);
  if (nestedColumn - baseColumn < requirement.minimumExtraColumns) {
    throw new Error(
      `${fixtureName}: '${requirement.nested}' lost its relative code indentation ` +
      `(${nestedColumn - baseColumn} < ${requirement.minimumExtraColumns} columns).`
    );
  }
}

function inspectPpmPage(bytes) {
  let offset = 0;
  const tokens = [];
  while (tokens.length < 4 && offset < bytes.length) {
    while (offset < bytes.length && /\s/u.test(String.fromCharCode(bytes[offset]))) offset += 1;
    if (bytes[offset] === 0x23) {
      while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
      continue;
    }
    const start = offset;
    while (offset < bytes.length && !/\s/u.test(String.fromCharCode(bytes[offset]))) offset += 1;
    tokens.push(bytes.subarray(start, offset).toString("ascii"));
  }
  const [magic, widthToken, heightToken, maxToken] = tokens;
  const width = Number(widthToken);
  const height = Number(heightToken);
  if (magic !== "P6" || Number(maxToken) !== 255 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new Error(`Unexpected PPM header: ${tokens.join(" ")}`);
  }
  if (offset >= bytes.length || !/\s/u.test(String.fromCharCode(bytes[offset]))) {
    throw new Error("PPM header is missing its binary-data delimiter.");
  }
  // Consume only the header delimiter (or CRLF pair). Binary pixel bytes are
  // allowed to equal ASCII whitespace and must never be skipped as text.
  offset += bytes[offset] === 0x0d && bytes[offset + 1] === 0x0a ? 2 : 1;
  const pixelBytes = width * height * 3;
  if (pixelBytes <= 0 || bytes.length - offset < pixelBytes) throw new Error("Incomplete PPM pixel data.");
  const pixels = bytes.subarray(offset, offset + pixelBytes);
  const background = [pixels[0], pixels[1], pixels[2]];
  let minLuminance = 255;
  let maxLuminance = 0;
  let nonBackgroundPixels = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    minLuminance = Math.min(minLuminance, luminance);
    maxLuminance = Math.max(maxLuminance, luminance);
    if (Math.max(
      Math.abs(red - background[0]),
      Math.abs(green - background[1]),
      Math.abs(blue - background[2])
    ) > 12) nonBackgroundPixels += 1;
  }
  return {
    width,
    height,
    pixels,
    background,
    dynamicRange: maxLuminance - minLuminance,
    nonBackgroundPixels,
    pixelDigest: createHash("sha256").update(pixels).digest("hex")
  };
}

function findExactVerticalPageOverlap(previous, current) {
  if (previous.width !== current.width || previous.height !== current.height) return 0;
  const widthBytes = previous.width * 3;
  // A full duplicate is caught by the page digest; scan every smaller overlap
  // so a renderer repeating most of a page cannot evade the boundary check.
  const maximumRows = Math.min(previous.height, current.height) - 1;
  const minimumRows = 6;
  for (let rows = maximumRows; rows >= minimumRows; rows -= 1) {
    const previousStart = (previous.height - rows) * widthBytes;
    const previousStrip = previous.pixels.subarray(previousStart);
    const currentStrip = current.pixels.subarray(0, rows * widthBytes);
    if (!previousStrip.equals(currentStrip)) continue;
    const stripMetrics = inspectRawRgbStrip(previousStrip, previous.background);
    const minimumForeground = Math.max(80, Math.floor(previous.width * rows * 0.003));
    if (stripMetrics.dynamicRange >= 8 && stripMetrics.nonBackgroundPixels >= minimumForeground) {
      return rows;
    }
  }
  return 0;
}

function inspectRawRgbStrip(pixels, background) {
  let minLuminance = 255;
  let maxLuminance = 0;
  let nonBackgroundPixels = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    minLuminance = Math.min(minLuminance, luminance);
    maxLuminance = Math.max(maxLuminance, luminance);
    if (Math.max(
      Math.abs(red - background[0]),
      Math.abs(green - background[1]),
      Math.abs(blue - background[2])
    ) > 12) nonBackgroundPixels += 1;
  }
  return { dynamicRange: maxLuminance - minLuminance, nonBackgroundPixels };
}

function runVerifierSelfTests() {
  const whitespacePixels = Buffer.from([0x20, 0x0a, 0x0d, 0xff, 0x00, 0x7f]);
  for (const delimiter of ["\n", "\r\n"]) {
    const ppm = Buffer.concat([Buffer.from(`P6\n2 1\n255${delimiter}`, "ascii"), whitespacePixels]);
    const inspected = inspectPpmPage(ppm);
    if (!inspected.pixels.equals(whitespacePixels)) {
      throw new Error(`PPM ${JSON.stringify(delimiter)} delimiter consumed binary whitespace pixels.`);
    }
  }

  const width = 100;
  const height = 100;
  const rowBytes = width * 3;
  const previousPixels = Buffer.alloc(width * height * 3, 255);
  const currentPixels = Buffer.alloc(width * height * 3, 255);
  for (let row = 1; row < height; row += 1) {
    const color = row % 2 === 0 ? 0 : 96;
    previousPixels.fill(color, row * rowBytes, (row + 1) * rowBytes);
  }
  previousPixels.subarray(rowBytes).copy(currentPixels, 0);
  currentPixels.fill(180, (height - 1) * rowBytes);
  const previous = { width, height, pixels: previousPixels, background: [255, 255, 255] };
  const current = { width, height, pixels: currentPixels, background: [96, 96, 96] };
  const overlap = findExactVerticalPageOverlap(previous, current);
  if (overlap !== height - 1) {
    throw new Error(`Expected a 99-row repeated page boundary, received ${overlap}.`);
  }
  process.stdout.write("Verified binary-whitespace PPM parsing and 99%-page exact-overlap detection.\n");
}
