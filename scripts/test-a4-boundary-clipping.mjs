#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import fontkit from "pdflib-fontkit";
import { PDFDocument, rgb } from "pdf-lib";

const A4_WIDTH_PT = 210 * 72 / 25.4;
const A4_HEIGHT_PT = 297 * 72 / 25.4;
const SOURCE_WIDTH_PX = 210 * 96 / 25.4;
const PX_TO_PT = A4_WIDTH_PT / SOURCE_WIDTH_PX;
const A4_HEIGHT_PX = A4_HEIGHT_PT / PX_TO_PT;
const RENDER_DPI = 96;
const outputDir = resolve(process.env.A4_BOUNDARY_OUTPUT ?? "tmp/pdfs/a4-boundary-clipping");
const helperDir = mkdtempSync(`${tmpdir()}/mobile-pdf-a4-boundary-`);
const helperPath = resolve(helperDir, "text-layout.mjs");
const candidatePdfPath = resolve(outputDir, "a4-boundary-candidate.pdf");
const referencePdfPath = resolve(outputDir, "a4-boundary-reference.pdf");
const metricsPath = resolve(outputDir, "a4-boundary-metrics.json");
const fontPath = resolve("fonts/NotoSansCJKkr-Regular.ko-subset.ttf");

const cases = [
  createCrossingCase("A4_BOUNDARY_01", "한글 경계 gypqj 선택", 24, 0.25, 26),
  createCrossingCase("A4_BOUNDARY_02", "받침과 descender 경계 검증", 26, 0.75, 28),
  createCrossingCase("A4_BOUNDARY_03", "굵은 한글 INLINE 경계", 28, 1.5, 31),
  createCrossingCase("A4_BOUNDARY_04", "NFD 가 옛한글 ᄒᆞᆫ 경계", 25, 1.999, 29),
  {
    id: "A4_BOUNDARY_05",
    text: "페이지 시작을 1px만 넘긴 큰 글자 한글 gypq",
    fontSizePx: 32,
    top: A4_HEIGHT_PX - 1,
    bottom: A4_HEIGHT_PX + 35,
    contentHeightPx: A4_HEIGHT_PX + 96
  },
  {
    id: "A4_BOUNDARY_06",
    text: "중앙이 정확히 경계인 한글 gypq",
    fontSizePx: 30,
    top: A4_HEIGHT_PX - 17,
    bottom: A4_HEIGHT_PX + 17,
    contentHeightPx: A4_HEIGHT_PX + 96
  },
  {
    id: "A4_BOUNDARY_07",
    text: "A4 마지막 1px 미만 꼬리 한글",
    fontSizePx: 24,
    top: A4_HEIGHT_PX - 24,
    bottom: A4_HEIGHT_PX + 0.75,
    contentHeightPx: A4_HEIGHT_PX + 0.75
  }
];

try {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  await build({
    entryPoints: [resolve("src/text-layout.ts")],
    bundle: true,
    format: "esm",
    outfile: helperPath,
    platform: "node",
    target: "es2021",
    logLevel: "silent"
  });
  const layout = await import(pathToFileURL(helperPath).href);
  if (typeof layout.computePageBreaks !== "function") {
    throw new Error("src/text-layout.ts must export computePageBreaks for the A4 boundary regression fixture.");
  }

  const fontBytes = readFileSync(fontPath);
  const candidate = await PDFDocument.create();
  candidate.registerFontkit(fontkit);
  const candidateFont = await candidate.embedFont(fontBytes, { subset: true });
  const reference = await PDFDocument.create();
  reference.registerFontkit(fontkit);
  const referenceFont = await reference.embedFont(fontBytes, { subset: true });
  const records = [];

  for (const fixture of cases) {
    const fragment = {
      left: 56,
      right: SOURCE_WIDTH_PX - 56,
      top: fixture.top,
      bottom: fixture.bottom,
      priority: 1
    };
    const pageBreaks = layout.computePageBreaks(
      fixture.contentHeightPx,
      A4_HEIGHT_PX,
      [fragment]
    );
    const geometryFailures = inspectPageBreakGeometry(fixture, fragment, pageBreaks);
    const candidatePageNumbers = [];

    for (let index = 0; index < pageBreaks.length - 1; index += 1) {
      const pageTopPx = pageBreaks[index];
      const pageBottomPx = pageBreaks[index + 1];
      const page = candidate.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
      candidatePageNumbers.push(candidate.getPageCount());
      if (layout.verticalCenterBelongsToPage(
        fragment.top,
        fragment.bottom,
        pageTopPx,
        pageBottomPx
      )) {
        drawFixtureText(page, candidateFont, fixture, fragment.top - pageTopPx);
      }
    }

    const referencePage = reference.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    drawFixtureText(referencePage, referenceFont, fixture, 52);
    records.push({
      id: fixture.id,
      text: fixture.text,
      fragment: { top: fragment.top, bottom: fragment.bottom },
      contentHeightPx: fixture.contentHeightPx,
      pageBreaks,
      candidatePageNumbers,
      referencePageNumber: reference.getPageCount(),
      geometryFailures
    });
  }

  writeFileSync(candidatePdfPath, await candidate.save({ useObjectStreams: true }));
  writeFileSync(referencePdfPath, await reference.save({ useObjectStreams: true }));

  const pdftoppm = resolvePopplerTool("PDFTOPPM", "pdftoppm");
  const pdftotext = resolvePopplerTool("PDFTOTEXT", "pdftotext");
  const candidatePrefix = resolve(outputDir, "candidate-page");
  const referencePrefix = resolve(outputDir, "reference-page");
  // PPM is pdftoppm's default output format. Newer Poppler versions reject
  // the old, redundant `-ppm` spelling while distro versions also accept this.
  run(pdftoppm, ["-r", String(RENDER_DPI), candidatePdfPath, candidatePrefix]);
  run(pdftoppm, ["-r", String(RENDER_DPI), referencePdfPath, referencePrefix]);
  run(pdftoppm, ["-png", "-r", "120", candidatePdfPath, resolve(outputDir, "candidate-visual")]);
  run(pdftoppm, ["-png", "-r", "120", referencePdfPath, resolve(outputDir, "reference-visual")]);

  const candidatePages = readRenderedPages(candidatePrefix);
  const referencePages = readRenderedPages(referencePrefix);
  assert.equal(candidatePages.length, records.at(-1).candidatePageNumbers.at(-1));
  assert.equal(referencePages.length, records.length);
  const extracted = run(pdftotext, ["-enc", "UTF-8", candidatePdfPath, "-"]);
  const failures = [];

  for (const record of records) {
    failures.push(...record.geometryFailures.map((message) => `${record.id}: ${message}`));
    const referenceMetrics = inspectInk(referencePages[record.referencePageNumber - 1]);
    const candidateMetrics = record.candidatePageNumbers.map((pageNumber) =>
      inspectInk(candidatePages[pageNumber - 1])
    );
    const nonblank = candidateMetrics
      .map((metrics, index) => ({ metrics, pageNumber: record.candidatePageNumbers[index] }))
      .filter(({ metrics }) => metrics.inkPixels >= 20);
    const selected = nonblank.sort((left, right) => right.metrics.inkPixels - left.metrics.inkPixels)[0] ?? null;
    const inkRatio = selected ? selected.metrics.inkPixels / Math.max(1, referenceMetrics.inkPixels) : 0;
    const heightRatio = selected?.metrics.bbox && referenceMetrics.bbox
      ? selected.metrics.bbox.height / Math.max(1, referenceMetrics.bbox.height)
      : 0;
    const edgeContact = Boolean(selected?.metrics.bbox && (
      selected.metrics.bbox.top <= 1 || selected.metrics.bbox.bottom >= selected.metrics.height - 2
    ));
    const selectableCount = countOccurrences(extracted, record.id);

    if (nonblank.length !== 1) {
      failures.push(`${record.id}: visible glyphs occupy ${nonblank.length} candidate pages instead of exactly one.`);
    }
    if (inkRatio < 0.86 || inkRatio > 1.14) {
      failures.push(`${record.id}: rendered ink ratio ${inkRatio.toFixed(3)} indicates clipped or duplicated glyphs.`);
    }
    if (heightRatio < 0.86 || heightRatio > 1.14) {
      failures.push(`${record.id}: rendered glyph-height ratio ${heightRatio.toFixed(3)} indicates vertical clipping.`);
    }
    // A break exactly at the measured text-rectangle top can legitimately put
    // antialiased ink on row zero. Treat it as clipping only when the rendered
    // ink mass or height is also smaller than the safely inset reference.
    if (edgeContact && (inkRatio < 0.98 || heightRatio < 0.98)) {
      failures.push(`${record.id}: edge-contacting glyphs lost visible ink or height.`);
    }
    if (selectableCount !== 1) {
      failures.push(`${record.id}: selectable sentinel occurs ${selectableCount} times instead of once.`);
    }

    Object.assign(record, {
      referenceMetrics,
      candidateMetrics,
      visualMetrics: {
        nonblankPageCount: nonblank.length,
        selectedPageNumber: selected?.pageNumber ?? null,
        inkRatio,
        heightRatio,
        edgeContact,
        selectableCount
      }
    });
    process.stdout.write(
      `${record.id}: breaks=[${record.pageBreaks.map(formatNumber).join(", ")}], ` +
      `ink=${inkRatio.toFixed(3)}, height=${heightRatio.toFixed(3)}, ` +
      `edge=${edgeContact ? "yes" : "no"}, selectable=${selectableCount}\n`
    );
  }

  writeFileSync(metricsPath, `${JSON.stringify({
    a4: {
      widthPt: A4_WIDTH_PT,
      heightPt: A4_HEIGHT_PT,
      sourceWidthPx: SOURCE_WIDTH_PX,
      physicalPageHeightPx: A4_HEIGHT_PX,
      renderDpi: RENDER_DPI
    },
    records,
    failures
  }, null, 2)}\n`);

  if (failures.length > 0) {
    throw new Error(`A4 page-boundary clipping regression failed:\n- ${failures.join("\n- ")}`);
  }
  process.stdout.write(
    `Verified ${records.length} A4 boundary cases: no intersected breaks, clipped/duplicated glyphs, ` +
    `unsafe physical-edge loss, or selectable-text duplication. Artifacts: ${outputDir}\n`
  );
} finally {
  rmSync(helperDir, { recursive: true, force: true });
}

function createCrossingCase(id, text, fontSizePx, overflowPx, fragmentHeightPx) {
  return {
    id,
    text,
    fontSizePx,
    top: A4_HEIGHT_PX + overflowPx - fragmentHeightPx,
    bottom: A4_HEIGHT_PX + overflowPx,
    contentHeightPx: A4_HEIGHT_PX + 96
  };
}

function inspectPageBreakGeometry(fixture, fragment, pageBreaks) {
  const failures = [];
  if (!Array.isArray(pageBreaks) || pageBreaks.length < 2 || pageBreaks[0] !== 0) {
    return ["page breaks must start at zero and contain at least one interval."];
  }
  const lastBreak = pageBreaks.at(-1);
  if (Math.abs(lastBreak - fixture.contentHeightPx) > 1e-7) {
    failures.push(`last break ${formatNumber(lastBreak)} does not equal content height ${formatNumber(fixture.contentHeightPx)}.`);
  }
  for (let index = 1; index < pageBreaks.length; index += 1) {
    const pageTop = pageBreaks[index - 1];
    const pageBottom = pageBreaks[index];
    if (!(pageBottom > pageTop)) failures.push(`interval ${index} does not make positive progress.`);
    if (pageBottom - pageTop > A4_HEIGHT_PX + 1e-7) {
      failures.push(`interval ${index} exceeds physical A4 height by ${formatNumber(pageBottom - pageTop - A4_HEIGHT_PX)}px.`);
    }
  }
  for (const pageBreak of pageBreaks.slice(1, -1)) {
    if (fragment.top < pageBreak && fragment.bottom > pageBreak) {
      failures.push(
        `break ${formatNumber(pageBreak)} intersects text [${formatNumber(fragment.top)}, ${formatNumber(fragment.bottom)}].`
      );
    }
  }
  const containingIntervals = pageBreaks.slice(0, -1).filter((pageTop, index) =>
    fragment.top >= pageTop - 1e-7 && fragment.bottom <= pageBreaks[index + 1] + 1e-7
  );
  if (containingIntervals.length !== 1) {
    failures.push(`text fragment is wholly contained by ${containingIntervals.length} page intervals instead of one.`);
  }
  return failures;
}

function drawFixtureText(page, font, fixture, localTopPx) {
  const fontSizePt = fixture.fontSizePx * PX_TO_PT;
  const baselineY = A4_HEIGHT_PT - (localTopPx + fixture.fontSizePx * 0.86) * PX_TO_PT;
  page.drawText(`${fixture.id} ${fixture.text}`, {
    x: 42,
    y: baselineY,
    size: fontSizePt,
    font,
    color: rgb(0.02, 0.02, 0.02)
  });
}

function resolvePopplerTool(environmentName, command) {
  if (process.env[environmentName]) return process.env[environmentName];
  const pathProbe = spawnSync(command, ["-v"], { encoding: "utf8" });
  if (pathProbe.error?.code !== "ENOENT") return command;
  const candidates = [
    resolve(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin",
      command
    ),
    resolve("/opt/homebrew/bin", command),
    resolve("/usr/local/bin", command)
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-v"], { encoding: "utf8" });
    if (probe.error?.code !== "ENOENT") return candidate;
  }
  return command;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0 || result.signal) {
    throw new Error(
      `${command} failed with status ${result.status ?? "null"}` +
      `${result.signal ? ` and signal ${result.signal}` : ""}.\n${result.stderr || result.stdout || ""}`
    );
  }
  return result.stdout;
}

function readRenderedPages(prefix) {
  const folder = dirname(prefix);
  const stem = basename(prefix);
  return readdirSync(folder)
    .map((file) => ({ file, match: file.match(new RegExp(`^${stem}-(\\d+)\\.ppm$`, "u")) }))
    .filter((entry) => entry.match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map((entry) => readPpm(resolve(folder, entry.file)));
}

function readPpm(path) {
  const bytes = readFileSync(path);
  let offset = 0;
  const readToken = () => {
    while (offset < bytes.length) {
      if (bytes[offset] === 0x23) {
        while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
      } else if (bytes[offset] <= 0x20) {
        offset += 1;
      } else {
        break;
      }
    }
    const start = offset;
    while (offset < bytes.length && bytes[offset] > 0x20 && bytes[offset] !== 0x23) offset += 1;
    return bytes.toString("ascii", start, offset);
  };
  const magic = readToken();
  const width = Number(readToken());
  const height = Number(readToken());
  const maximum = Number(readToken());
  while (offset < bytes.length && bytes[offset] <= 0x20) offset += 1;
  if (magic !== "P6" || !Number.isInteger(width) || !Number.isInteger(height) || maximum !== 255) {
    throw new Error(`Unsupported PPM header in ${path}.`);
  }
  const expectedBytes = width * height * 3;
  if (bytes.length - offset !== expectedBytes) {
    throw new Error(`PPM payload mismatch in ${path}: ${bytes.length - offset} != ${expectedBytes}.`);
  }
  return { width, height, pixels: bytes.subarray(offset) };
}

function inspectInk(image) {
  let inkPixels = 0;
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let index = 0; index < image.pixels.length; index += 3) {
    const darkest = Math.min(image.pixels[index], image.pixels[index + 1], image.pixels[index + 2]);
    if (darkest >= 232) continue;
    const pixelIndex = index / 3;
    const x = pixelIndex % image.width;
    const y = Math.floor(pixelIndex / image.width);
    inkPixels += 1;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return {
    width: image.width,
    height: image.height,
    inkPixels,
    bbox: inkPixels > 0
      ? { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
      : null
  };
}

function countOccurrences(text, value) {
  return text.split(value).length - 1;
}

function formatNumber(value) {
  return Number(value).toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}
