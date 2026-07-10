#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import fontkit from "pdflib-fontkit";
import pako from "pako";
import { build } from "esbuild";
import { PDFDocument, rgb } from "pdf-lib";

const fontPath = resolve(
  process.argv[2] ?? "fonts/NotoSansCJKkr-Regular.ko-subset.ttf.gz"
);
const pdfPath = resolve(process.argv[3] ?? "dist/korean-selectable-smoke.pdf");
const pdftotext = process.env.PDFTOTEXT ?? "pdftotext";
const pdffonts = process.env.PDFFONTS ?? (
  pdftotext.includes("/") ? resolve(dirname(pdftotext), "pdffonts") : "pdffonts"
);
const pdftoppm = process.env.PDFTOPPM ?? (
  pdftotext.includes("/") ? resolve(dirname(pdftotext), "pdftoppm") : "pdftoppm"
);
const usePdfFontSubset = process.env.PDF_FONT_SUBSET !== "0";

const koreanOnlyLines = [
  "한글 글꼴 렌더링 검증 가나다라마바사",
  "옛한글 자모 렌더링 ᄒᆞᆫ글"
];
const sourceLines = [
  "한글 선택 테스트: 가나다라마바사아자차카타파하",
  "혼합 문장: Obsidian PDF 2026 · ₩12,345",
  "옛한글 자모: ᄒᆞᆫ글",
  "한자 혼합: 앞漢字뒤 유지",
  "이모지 혼합: 앞😀뒤 유지",
  "미지원 문자 혼합: A한글مرحباB"
];
const expectedFilteredLines = [
  ...sourceLines.slice(0, 3),
  "한자 혼합: 앞뒤 유지",
  "이모지 혼합: 앞뒤 유지",
  "미지원 문자 혼합: A한글B"
];
const expectedLines = [...koreanOnlyLines, ...expectedFilteredLines];

const fontBytes = fontPath.endsWith(".gz")
  ? gunzipSync(readFileSync(fontPath))
  : readFileSync(fontPath);
if (fontPath.endsWith(".gz")) {
  const fallbackFontBytes = Buffer.from(pako.ungzip(readFileSync(fontPath)));
  if (!fallbackFontBytes.equals(fontBytes)) {
    throw new Error("The JavaScript gzip fallback produced different font bytes.");
  }
}
if (!fontBytes.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]))) {
  throw new Error(`Expected a static TrueType font at ${fontPath}.`);
}

const pdf = await PDFDocument.create();
pdf.registerFontkit(fontkit);
const font = await pdf.embedFont(fontBytes, {
  subset: usePdfFontSubset,
  customName: "KRTEST+NotoSansCJKkr-Regular"
});
const koreanOnlyPage = pdf.addPage([595.28, 841.89]);
const page = pdf.addPage([595.28, 841.89]);
const characterSet = new Set(font.getCharacterSet());
for (let codePoint = 0xac00; codePoint <= 0xd7a3; codePoint += 1) {
  if (!characterSet.has(codePoint)) {
    throw new Error(`Modern Hangul coverage is incomplete at U+${codePoint.toString(16).toUpperCase()}.`);
  }
}
for (const codePoint of [0x1100, 0x11ff, 0x3131, 0x318e, 0xa960, 0xd7b0, 0xffa0, 0xffdc]) {
  if (!characterSet.has(codePoint)) {
    throw new Error(`Hangul jamo coverage is incomplete at U+${codePoint.toString(16).toUpperCase()}.`);
  }
}

const helperDir = mkdtempSync(`${tmpdir()}/mobile-pdf-exporter-kr-`);
const helperBundle = resolve(helperDir, "pdf-text.mjs");
await build({
  entryPoints: [resolve("src/pdf-text.ts")],
  bundle: true,
  format: "esm",
  outfile: helperBundle,
  platform: "node",
  target: "es2021"
});
const { getEncodablePdfText } = await import(pathToFileURL(helperBundle).href);
const lines = sourceLines.map((line) => getEncodablePdfText(font, line));
rmSync(helperDir, { recursive: true, force: true });

for (const [index, line] of koreanOnlyLines.entries()) {
  koreanOnlyPage.drawText(line, {
    x: 48,
    y: 780 - index * 42,
    size: 18,
    font,
    color: rgb(0.08, 0.08, 0.08)
  });
}

for (const [index, line] of lines.entries()) {
  if (line !== expectedFilteredLines[index]) {
    throw new Error(`Text filtering mismatch. Expected '${expectedFilteredLines[index]}', received '${line}'.`);
  }
  font.encodeText(line);
  page.drawText(line, {
    x: 48,
    y: 780 - index * 42,
    size: 18,
    font,
    color: rgb(0.08, 0.08, 0.08)
  });
}

mkdirSync(dirname(pdfPath), { recursive: true });
const pdfBytes = await pdf.save({ useObjectStreams: true });
const maximumPdfBytes = usePdfFontSubset ? 500_000 : 12_000_000;
if (pdfBytes.byteLength > maximumPdfBytes) {
  throw new Error(`Smoke PDF is unexpectedly large (${pdfBytes.byteLength} bytes); font subsetting may have regressed.`);
}
writeFileSync(pdfPath, pdfBytes);

const extraction = spawnSync(pdftotext, ["-enc", "UTF-8", pdfPath, "-"], { encoding: "utf8" });
if (extraction.error?.code === "ENOENT") {
  if (process.env.SKIP_POPPLER === "1") {
    process.stdout.write(`Created ${pdfPath}; Poppler verification was explicitly skipped.\n`);
    process.exit(0);
  }
  throw new Error("pdftotext is required. Set PDFTOTEXT or explicitly set SKIP_POPPLER=1.");
}
if (extraction.error) throw new Error(`pdftotext could not run: ${extraction.error.message}`);
if (extraction.status !== 0 || extraction.signal) {
  process.stderr.write(extraction.stderr || "pdftotext failed\n");
  process.exit(extraction.status ?? 1);
}
if (extraction.stderr?.trim()) throw new Error(`pdftotext reported a warning:\n${extraction.stderr}`);

const extractedLines = extraction.stdout
  .normalize("NFC")
  .replace(/\r\n?/gu, "\n")
  .split(/[\n\f]/u)
  .map((line) => line.trim())
  .filter(Boolean);
const normalizedExpected = expectedLines.map((line) => line.normalize("NFC"));
if (JSON.stringify(extractedLines) !== JSON.stringify(normalizedExpected)) {
  process.stderr.write(
    `Selectable-text verification failed.\nExpected: ${JSON.stringify(normalizedExpected)}\nActual:   ${JSON.stringify(extractedLines)}\n`
  );
  process.exit(1);
}

const fontInspection = spawnSync(pdffonts, [pdfPath], { encoding: "utf8" });
if (fontInspection.error) throw new Error(`pdffonts could not run: ${fontInspection.error.message}`);
if (fontInspection.status !== 0 || fontInspection.signal) {
  process.stderr.write(fontInspection.stderr || "pdffonts failed\n");
  process.exit(fontInspection.status ?? 1);
}
if (fontInspection.stderr?.trim()) throw new Error(`pdffonts reported a warning:\n${fontInspection.stderr}`);
const fontRow = fontInspection.stdout.split(/\r?\n/u).find((line) => /NotoSansCJKkr/iu.test(line));
if (!fontRow || !/CID\s+TrueType/iu.test(fontRow) || !/\byes\s+yes\s+yes\b/iu.test(fontRow)) {
  process.stderr.write(`Expected embedded, subsetted CID TrueType font with a ToUnicode map.\n${fontInspection.stdout}\n`);
  process.exit(1);
}

const renderDir = mkdtempSync(`${tmpdir()}/mobile-pdf-exporter-kr-render-`);
const renderPrefix = resolve(renderDir, "page");
try {
  const rendering = spawnSync(
    pdftoppm,
    ["-f", "1", "-l", "1", "-r", "96", "-singlefile", pdfPath, renderPrefix],
    { encoding: "utf8" }
  );
  if (rendering.error) {
    throw new Error(`pdftoppm could not run: ${rendering.error.message}`);
  }
  if (rendering.status !== 0 || rendering.signal) {
    throw new Error(
      `pdftoppm failed with status ${rendering.status ?? "null"}` +
      `${rendering.signal ? ` and signal ${rendering.signal}` : ""}.\n${rendering.stderr || ""}`
    );
  }
  if (rendering.stderr?.trim()) {
    throw new Error(`pdftoppm reported a rendering warning:\n${rendering.stderr}`);
  }

  const renderedPagePath = `${renderPrefix}.ppm`;
  if (!existsSync(renderedPagePath)) {
    throw new Error(`pdftoppm did not create ${renderedPagePath}.`);
  }
  const { darkPixelCount, totalPixelCount } = inspectPpmPixels(readFileSync(renderedPagePath));
  const minimumDarkPixels = Math.max(500, Math.floor(totalPixelCount * 0.0005));
  if (darkPixelCount < minimumDarkPixels) {
    throw new Error(
      `Rendered PDF page appears blank (${darkPixelCount} dark pixels; expected at least ${minimumDarkPixels}).`
    );
  }
} finally {
  rmSync(renderDir, { recursive: true, force: true });
}

if (!existsSync(pdfPath)) throw new Error(`Missing generated PDF: ${pdfPath}`);
process.stdout.write(`Created ${pdfPath}\nSelectable Korean extraction verified for ${expectedLines.length} lines.\n`);

function inspectPpmPixels(bytes) {
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
  while (offset < bytes.length && /\s/u.test(String.fromCharCode(bytes[offset]))) offset += 1;
  const [magic, width, height, maximum] = tokens;
  if (magic !== "P6" || Number(maximum) !== 255) {
    throw new Error(`Unexpected PPM header: ${tokens.join(" ")}`);
  }
  const totalPixelCount = Number(width) * Number(height);
  const expectedBytes = totalPixelCount * 3;
  if (
    !Number.isSafeInteger(totalPixelCount) ||
    totalPixelCount <= 0 ||
    !Number.isSafeInteger(expectedBytes) ||
    bytes.length - offset < expectedBytes
  ) {
    throw new Error("Rendered PPM pixel data is incomplete.");
  }
  let count = 0;
  for (let index = offset; index < offset + expectedBytes; index += 3) {
    if (bytes[index] < 245 || bytes[index + 1] < 245 || bytes[index + 2] < 245) count += 1;
  }
  return { darkPixelCount: count, totalPixelCount };
}
