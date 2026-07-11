#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, stop as stopEsbuild } from "esbuild";

const outputDir = resolve(process.env.RENDER_FIDELITY_OUTPUT ?? "tmp/pdfs/render-fidelity");
const bundlePath = resolve(outputDir, "render-fidelity.bundle.js");
const pagePath = resolve(outputDir, "render-fidelity.html");
const screenshotPath = resolve(outputDir, "render-fidelity.png");
const resultsPath = resolve(outputDir, "render-fidelity-results.json");
const chrome = resolveChromeExecutable();
const python = process.env.PYTHON ?? "python3";

async function main() {
  mkdirSync(outputDir, { recursive: true });
  for (const stalePath of [
    bundlePath,
    pagePath,
    screenshotPath,
    resultsPath,
    resolve(outputDir, "render-fidelity-comparison.png")
  ]) {
    rmSync(stalePath, { force: true });
  }
  await build({
    entryPoints: [resolve("tests/render-fidelity.ts")],
    bundle: true,
    format: "iife",
    outfile: bundlePath,
    platform: "browser",
    target: ["safari15"],
    logLevel: "silent"
  });

  const template = readFileSync(resolve("tests/render-fidelity.html"), "utf8");
  const bundle = readFileSync(bundlePath, "utf8");
  if (!template.includes("/*__TEST_BUNDLE__*/")) throw new Error("Render fixture bundle marker is missing.");
  writeFileSync(pagePath, template.replace("/*__TEST_BUNDLE__*/", bundle));

  const userDataDir = mkdtempSync(`${tmpdir()}/mobile-pdf-render-chrome-`);
  const chromeArgs = [
    "--headless=new",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-font-subpixel-positioning",
    "--disable-lcd-text",
    "--font-render-hinting=none",
    "--force-color-profile=srgb",
    "--disable-sync",
    "--hide-scrollbars",
    "--no-first-run",
    "--allow-file-access-from-files",
    "--force-device-scale-factor=1",
    "--run-all-compositor-stages-before-draw",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1660,3600",
    "about:blank"
  ];
  const pageUrl = pathToFileURL(pagePath).href;
  try {
    const { results, screenshot } = await captureFixtureInSingleSession(chrome, chromeArgs, pageUrl);
    if (!results.ok) throw new Error(`Render fixture failed in the browser:\n${results.error ?? "unknown error"}`);
    assertAdversarialCoverage(results);
    writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(screenshotPath, screenshot);
  } finally {
    removeTemporaryBrowserProfile(userDataDir);
  }

  const comparisonArgs = [resolve("scripts/compare-render-fidelity.py"), screenshotPath, resultsPath, outputDir];
  if (process.platform === "linux") comparisonArgs.push("linux");
  const comparison = spawnSync(
    python,
    comparisonArgs,
    { encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 }
  );
  if (comparison.error?.code === "ENOENT") {
    throw new Error(`Python is required for visual comparison. Set PYTHON to a Python with Pillow installed.`);
  }
  assertSpawnSucceeded(comparison, "Visual fidelity comparison");
  process.stdout.write(comparison.stdout);
  process.stdout.write(`Rendered fidelity artifacts: ${outputDir}\n`);
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Chrome or Chromium is required for render fidelity tests. Set CHROME_BIN.");
  return executable;
}

function removeTemporaryBrowserProfile(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch (error) {
    // Linux Chrome helpers can briefly recreate cache files after the browser
    // process exits. The runner OS cleans /tmp; a cleanup race must not hide a
    // completed fidelity result, while unexpected filesystem errors still fail.
    if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
    process.stderr.write(`Render test left a temporary Chrome profile after cleanup retries: ${path}\n`);
  }
}

function assertSpawnSucceeded(result, label) {
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0 || result.signal) {
    throw new Error(
      `${label} failed with status ${result.status ?? "null"}` +
      `${result.signal ? ` and signal ${result.signal}` : ""}.\n${result.stdout || ""}${result.stderr || ""}`
    );
  }
}

function assertAdversarialCoverage(results) {
  if (!Array.isArray(results.cases)) throw new Error("Render fixture cases are missing.");
  const caseIds = new Set(results.cases.map((item) => item?.id));
  const requiredCaseIds = [
    "inline-korean",
    "table-callout",
    "lists-code",
    "media-dark",
    "adversarial-text",
    "adversarial-layers",
    "complex-table",
    "layout-exotics",
    "pagination-nonuniform-a",
    "pagination-nonuniform-b",
    "pagination-nonuniform-c",
    "pagination-nonuniform-d",
    "pagination-slice"
  ];
  const missing = requiredCaseIds.filter((id) => !caseIds.has(id));
  if (missing.length > 0) throw new Error(`Render fixture coverage is incomplete: ${missing.join(", ")}.`);
  const coverage = results.coverage;
  if (!coverage || coverage.longUnbrokenKoreanCharacters < 250 || coverage.longUrlCharacters < 220) {
    throw new Error("Adversarial long-text coverage was not recorded.");
  }
  if (!Array.isArray(coverage.whitespaceModes) || coverage.whitespaceModes.length < 4) {
    throw new Error("Whitespace-mode coverage was not recorded.");
  }
  if (!Array.isArray(coverage.nonuniformSliceHeights) ||
      coverage.nonuniformSliceHeights.length < 4 ||
      new Set(coverage.nonuniformSliceHeights).size < 4) {
    throw new Error("At least four distinct nonuniform page slices are required.");
  }
}

async function captureFixtureInSingleSession(executable, args, url) {
  const browser = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  browser.stderr.setEncoding("utf8");
  browser.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const webSocketUrl = await waitForDevToolsUrl(browser, () => stderr, 20_000);
    const client = await CdpClient.connect(webSocketUrl);
    try {
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
      await client.send("Page.enable", {}, sessionId);
      await client.send("Runtime.enable", {}, sessionId);
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 1660,
        height: 3600,
        deviceScaleFactor: 1,
        mobile: false
      }, sessionId);
      await client.send("Page.navigate", { url }, sessionId);
      await waitForFixtureReady(client, sessionId, 60_000);
      const results = await evaluateByValue(
        client,
        sessionId,
        `JSON.parse(document.getElementById("render-fidelity-results").textContent)`
      );
      const layout = await client.send("Page.getLayoutMetrics", {}, sessionId);
      const contentHeight = Math.max(1, Math.ceil(layout.cssContentSize?.height ?? layout.contentSize?.height ?? 3600));
      const capture = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1660, height: contentHeight, scale: 1 }
      }, sessionId);
      return { results, screenshot: Buffer.from(capture.data, "base64") };
    } finally {
      await client.send("Browser.close").catch(() => undefined);
      client.close();
    }
  } catch (error) {
    throw new Error(`Chrome fidelity session failed: ${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  } finally {
    await terminateChildProcess(browser);
  }
}

async function terminateChildProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(3_000)]);
  }
}

async function waitForDevToolsUrl(process, readStderr, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = readStderr().match(/DevTools listening on (ws:\/\/[^\s]+)/u);
    if (match) return match[1];
    if (process.exitCode !== null) throw new Error(`Chrome exited with status ${process.exitCode}.`);
    await delay(50);
  }
  throw new Error("Chrome DevTools endpoint timed out.");
}

async function waitForFixtureReady(client, sessionId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await evaluateByValue(
      client,
      sessionId,
      `document.documentElement.dataset.testReady === "true"`
    ).catch(() => false);
    if (ready) return;
    await delay(80);
  }
  throw new Error("Render fixture readiness timed out.");
}

async function evaluateByValue(client, sessionId, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Runtime evaluation failed.");
  }
  return response.result?.value;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Chrome DevTools connection closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chrome DevTools WebSocket timed out.")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Chrome DevTools WebSocket failed.")); }, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: Chrome DevTools command timed out.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, method, timeout });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  await main();
} finally {
  stopEsbuild();
}
// This is a one-shot CLI. Node's WebSocket implementation can retain a
// closed CDP handle when this command itself is run under spawnSync (the
// WKWebView wrapper), so terminate explicitly after every successful cleanup.
await new Promise((resolveFlush) => process.stdout.write("", resolveFlush));
process.exit(0);
