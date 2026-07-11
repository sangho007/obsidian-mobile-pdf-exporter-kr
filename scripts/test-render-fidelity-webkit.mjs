#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { resolve } from "node:path";

const chromeOutputDir = resolve("tmp/pdfs/render-fidelity");
const webkitOutputDir = resolve("tmp/pdfs/render-fidelity-webkit");
const htmlPath = resolve(chromeOutputDir, "render-fidelity.html");
const nativeSnapshotPath = resolve(webkitOutputDir, "render-fidelity-webkit-native.png");
const snapshotPath = resolve(webkitOutputDir, "render-fidelity-webkit.png");
const resultsPath = resolve(webkitOutputDir, "render-fidelity-webkit-results.json");
const swiftHarnessPath = resolve("scripts/test-render-fidelity-webkit.swift");
const comparisonScriptPath = resolve("scripts/compare-render-fidelity.py");
const python = process.env.PYTHON ?? "python3";

try {
  if (process.platform !== "darwin") {
    throw new Error(
      `WKWebView fidelity smoke requires macOS (darwin); current platform is ${process.platform}. ` +
      "Run the ordinary Chrome test with `npm run test:render-fidelity` on this platform."
    );
  }

  rmSync(webkitOutputDir, { recursive: true, force: true });
  mkdirSync(webkitOutputDir, { recursive: true });

  runNpmScript("test:render-fidelity", timeoutFromEnvironment("WEBKIT_CHROME_TIMEOUT_MS", 180_000));
  requireFile(htmlPath, "Chrome-generated render fixture");
  requireFile(swiftHarnessPath, "Swift WKWebView harness");

  runCommand(
    "swift",
    [swiftHarnessPath, htmlPath, nativeSnapshotPath, resultsPath],
    {
      label: "macOS WKWebView fidelity smoke",
      timeout: timeoutFromEnvironment("WEBKIT_SWIFT_TIMEOUT_MS", 180_000),
      env: {
        ...process.env,
        WKWEBVIEW_TIMEOUT_SECONDS: process.env.WKWEBVIEW_TIMEOUT_SECONDS ?? "120"
      }
    }
  );
  requireFile(nativeSnapshotPath, "native-scale WKWebView screenshot");
  requireFile(resultsPath, "WKWebView fixture results");

  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  assertWebKitResults(results);

  normalizeSnapshotToCssPixels(nativeSnapshotPath, snapshotPath);
  runCommand(
    python,
    [comparisonScriptPath, snapshotPath, resultsPath, webkitOutputDir, "webkit"],
    {
      label: "WKWebView visual fidelity comparison",
      timeout: timeoutFromEnvironment("WEBKIT_COMPARE_TIMEOUT_MS", 60_000)
    }
  );

  process.stdout.write(`WKWebView fidelity artifacts: ${webkitOutputDir}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function assertWebKitResults(results) {
  if (results?.ok !== true || !Array.isArray(results.cases) || results.cases.length !== 14) {
    throw new Error(
      `WKWebView fixture must produce exactly 14 successful comparable cases: ` +
      `${results?.error ?? results?.cases?.length ?? "invalid results"}`
    );
  }
  if (results.coverage?.primaryRasterScale !== 2 || results.webkitHarness?.primaryRasterScale !== 2) {
    throw new Error("WKWebView fixture did not preserve the required 2x primary raster scale metadata.");
  }
  const userAgent = String(results.webkitHarness?.userAgent ?? "");
  if (!userAgent.includes("AppleWebKit/") || /(?:Chrome|Chromium)\//u.test(userAgent)) {
    throw new Error(`WKWebView fixture reported a non-native WebKit user agent: ${userAgent || "missing"}.`);
  }
  const trace = results.webkitHarness?.trace;
  if (!trace || trace.serialized < 14 || trace.objectUrl <= 0 || trace.canvasBlob <= 0 ||
      trace.imageDecode <= 0 || trace.computedStyle <= 0) {
    throw new Error(`WKWebView fixture execution trace is incomplete: ${JSON.stringify(trace ?? null)}.`);
  }
}

function runNpmScript(script, timeout) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    runCommand(process.execPath, [npmCli, "run", script], {
      label: `npm run ${script}`,
      timeout,
      env: {
        ...process.env,
        RENDER_FIDELITY_OUTPUT: chromeOutputDir
      }
    });
    return;
  }
  runCommand("npm", ["run", script], {
    label: `npm run ${script}`,
    timeout,
    env: {
      ...process.env,
      RENDER_FIDELITY_OUTPUT: chromeOutputDir
    }
  });
}

function normalizeSnapshotToCssPixels(inputPath, outputPath) {
  const { width, height } = readPngDimensions(inputPath);
  const cssWidth = 1_660;
  if (width === cssWidth) {
    copyFileSync(inputPath, outputPath);
    return;
  }
  if (width < cssWidth || width % cssWidth !== 0) {
    throw new Error(
      `WKWebView screenshot width ${width}px cannot be mapped exactly to the ${cssWidth}px CSS fixture viewport.`
    );
  }
  const backingScale = width / cssWidth;
  const cssHeight = Math.round(height / backingScale);
  if (Math.abs(cssHeight * backingScale - height) > 0.01) {
    throw new Error(`WKWebView screenshot height ${height}px is inconsistent with backing scale ${backingScale}.`);
  }
  runCommand(
    "/usr/bin/sips",
    ["--resampleHeightWidth", String(cssHeight), String(cssWidth), inputPath, "--out", outputPath],
    {
      label: `WKWebView ${backingScale}x-to-1x screenshot normalization`,
      timeout: timeoutFromEnvironment("WEBKIT_SIPS_TIMEOUT_MS", 30_000)
    }
  );
  const normalized = readPngDimensions(outputPath);
  if (normalized.width !== cssWidth || normalized.height !== cssHeight) {
    throw new Error(
      `Normalized WKWebView screenshot has unexpected dimensions ${normalized.width} x ${normalized.height}.`
    );
  }
}

function readPngDimensions(path) {
  const bytes = readFileSync(path);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value) ||
      bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`Expected a valid PNG screenshot: ${path}`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

function runCommand(command, args, options) {
  process.stdout.write(`\n[webkit-fidelity] ${options.label}\n`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${options.label} timed out after ${options.timeout} ms.`);
  }
  if (result.error?.code === "ENOENT") {
    throw new Error(`${options.label} requires executable '${command}', but it was not found.`);
  }
  if (result.error) {
    throw new Error(`${options.label} could not run: ${result.error.message}`);
  }
  if (result.signal || result.status !== 0) {
    throw new Error(
      `${options.label} failed with status ${result.status ?? "null"}` +
      `${result.signal ? ` and signal ${result.signal}` : ""}.`
    );
  }
  return result;
}

function timeoutFromEnvironment(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : fallback;
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} was not produced: ${path}`);
}
