#!/usr/bin/env swift

import AppKit
import Foundation
import WebKit

guard CommandLine.arguments.count == 4 else {
    fputs(
        "usage: swift scripts/test-render-fidelity-webkit.swift HTML_PATH SNAPSHOT_PNG RESULTS_JSON\n",
        stderr
    )
    exit(2)
}

let htmlURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let snapshotURL = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
let resultsURL = URL(fileURLWithPath: CommandLine.arguments[3]).standardizedFileURL
let timeoutSeconds = Double(ProcessInfo.processInfo.environment["WKWEBVIEW_TIMEOUT_SECONDS"] ?? "120") ?? 120

guard FileManager.default.fileExists(atPath: htmlURL.path) else {
    fputs("WebKit fidelity HTML does not exist: \(htmlURL.path)\n", stderr)
    exit(2)
}

@MainActor
final class WebKitFidelityHarness: NSObject, WKNavigationDelegate {
    private let htmlURL: URL
    private let snapshotURL: URL
    private let resultsURL: URL
    private let timeoutSeconds: TimeInterval
    private let webView: WKWebView
    private let window: NSWindow
    private var pollTimer: Timer?
    private var timeoutTimer: Timer?
    private var evaluationPending = false
    private var finished = false
    private var navigationStatus = "not-started"
    private var pollCount = 0
    private var lastReadyState = "not-evaluated"

    init(htmlURL: URL, snapshotURL: URL, resultsURL: URL, timeoutSeconds: TimeInterval) {
        self.htmlURL = htmlURL
        self.snapshotURL = snapshotURL
        self.resultsURL = resultsURL
        self.timeoutSeconds = max(10, timeoutSeconds)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.addUserScript(WKUserScript(
            source: #"""
            window.__mobilePdfWebKitErrors = [];
            window.__mobilePdfWebKitTrace = { cloneNode: 0, computedStyle: 0, serialized: 0, objectUrl: 0, canvasBlob: 0, imageDecode: 0, animationFrame: 0 };
            window.requestAnimationFrame = callback => {
              window.__mobilePdfWebKitTrace.animationFrame += 1;
              return setTimeout(() => callback(performance.now()), 16);
            };
            window.cancelAnimationFrame = identifier => clearTimeout(identifier);
            const originalCloneNode = Node.prototype.cloneNode;
            Node.prototype.cloneNode = function(...args) {
              window.__mobilePdfWebKitTrace.cloneNode += 1;
              return originalCloneNode.apply(this, args);
            };
            const originalGetComputedStyle = window.getComputedStyle;
            window.getComputedStyle = function(...args) {
              window.__mobilePdfWebKitTrace.computedStyle += 1;
              return originalGetComputedStyle.apply(this, args);
            };
            const originalSerializeToString = XMLSerializer.prototype.serializeToString;
            XMLSerializer.prototype.serializeToString = function(...args) {
              window.__mobilePdfWebKitTrace.serialized += 1;
              return originalSerializeToString.apply(this, args);
            };
            const originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function(...args) {
              window.__mobilePdfWebKitTrace.objectUrl += 1;
              return originalCreateObjectURL.apply(this, args);
            };
            const originalToBlob = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function(...args) {
              window.__mobilePdfWebKitTrace.canvasBlob += 1;
              return originalToBlob.apply(this, args);
            };
            const originalImageDecode = HTMLImageElement.prototype.decode;
            HTMLImageElement.prototype.decode = function(...args) {
              window.__mobilePdfWebKitTrace.imageDecode += 1;
              const image = this;
              const nativeDecode = originalImageDecode.apply(image, args);
              const loadFallback = new Promise((resolve, reject) => {
                let timeout = 0;
                const cleanup = () => {
                  clearTimeout(timeout);
                  image.removeEventListener("load", loaded);
                  image.removeEventListener("error", failed);
                };
                const loaded = () => {
                  cleanup();
                  image.naturalWidth > 0 ? resolve() : reject(new Error("image has no decoded pixels"));
                };
                const failed = () => {
                  cleanup();
                  reject(new Error("image load failed"));
                };
                image.addEventListener("load", loaded, { once: true });
                image.addEventListener("error", failed, { once: true });
                timeout = setTimeout(() => {
                  image.complete && image.naturalWidth > 0 ? loaded() : failed();
                }, image.complete ? 0 : 5000);
              });
              return Promise.race([nativeDecode, loadFallback]);
            };
            window.addEventListener("error", event => {
              window.__mobilePdfWebKitErrors.push(String(event.error?.stack ?? event.message ?? "window error"));
            });
            window.addEventListener("unhandledrejection", event => {
              window.__mobilePdfWebKitErrors.push(String(event.reason?.stack ?? event.reason ?? "unhandled rejection"));
            });
            """#,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        self.webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 1_660, height: 3_600),
            configuration: configuration
        )
        self.window = NSWindow(
            contentRect: NSRect(x: -20_000, y: -20_000, width: 1_660, height: 3_600),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        super.init()
    }

    func start() {
        try? FileManager.default.createDirectory(
            at: snapshotURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? FileManager.default.createDirectory(
            at: resultsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.orderFrontRegardless()
        webView.navigationDelegate = self

        timeoutTimer = Timer.scheduledTimer(withTimeInterval: timeoutSeconds, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.fail(
                    "WKWebView fidelity smoke timed out after \(self.timeoutSeconds) seconds " +
                    "(navigation=\(self.navigationStatus), polls=\(self.pollCount), " +
                    "last-state=\(self.lastReadyState), loading=\(self.webView.isLoading), " +
                    "progress=\(self.webView.estimatedProgress))."
                )
            }
        }
        navigationStatus = "loading"
        webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        navigationStatus = "provisional"
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        navigationStatus = "committed"
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationStatus = "finished"
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.10, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollFixture() }
        }
        pollFixture()
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        fail("WKWebView navigation failed: \(error.localizedDescription)")
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        fail("WKWebView provisional navigation failed: \(error.localizedDescription)")
    }

    private func pollFixture() {
        guard !finished, !evaluationPending else { return }
        evaluationPending = true
        pollCount += 1
        let expression = #"""
        (() => JSON.stringify({
          ready: document.documentElement.dataset.testReady === "true",
          result: document.getElementById("render-fidelity-results")?.textContent ?? null,
          width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0)),
          height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)),
          userAgent: navigator.userAgent,
          rasterArtifacts: window.__mobilePdfRasterArtifacts ?? null,
          progress: {
            fonts: document.fonts?.status ?? "unavailable",
            sourceImages: Array.from(document.images).filter(image => image.closest(".snapshot-source")).length,
            completeSourceImages: Array.from(document.images).filter(image => image.closest(".snapshot-source") && image.complete).length,
            outputImages: document.querySelectorAll(".snapshot-output img").length,
            completedCases: Array.from(document.querySelectorAll(".pair")).filter(pair => pair.querySelector(".snapshot-output img")).map(pair => pair.dataset.case),
            errors: window.__mobilePdfWebKitErrors ?? [],
            firstLetterProbe: (() => {
              try {
                const probe = document.querySelector(".first-letter-probe");
                const node = Array.from(probe?.childNodes ?? []).find(item => item.nodeType === Node.TEXT_NODE);
                if (!node?.nodeValue) return null;
                const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(node.nodeValue));
                return {
                  text: node.nodeValue,
                  pseudoFontSize: getComputedStyle(probe.closest(".first-letter-case"), "::first-letter").fontSize,
                  heights: segments.map((segment, index) => {
                    const range = document.createRange();
                    range.setStart(node, segment.index);
                    range.setEnd(node, segments[index + 1]?.index ?? node.nodeValue.length);
                    return range.getBoundingClientRect().height;
                  })
                };
              } catch (error) {
                return { error: String(error?.stack ?? error) };
              }
            })()
            ,trace: window.__mobilePdfWebKitTrace ?? {}
          }
        }))()
        """#
        webView.evaluateJavaScript(expression) { [weak self] value, error in
            Task { @MainActor in
                guard let self else { return }
                self.evaluationPending = false
                if let error {
                    self.lastReadyState = "evaluation-error: \(error.localizedDescription)"
                    self.fail("WKWebView readiness evaluation failed: \(error.localizedDescription)")
                    return
                }
                guard let json = value as? String,
                      let data = json.data(using: .utf8),
                      let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let ready = state["ready"] as? Bool else {
                    self.lastReadyState = "invalid-evaluation-result"
                    return
                }
                self.lastReadyState = ready
                    ? "ready"
                    : "fixture-pending " + Self.compactJSONString(state["progress"])
                guard ready else { return }
                self.pollTimer?.invalidate()
                self.pollTimer = nil
                self.captureReadyFixture(state)
            }
        }
    }

    private func captureReadyFixture(_ state: [String: Any]) {
        guard let rawResults = state["result"] as? String,
              let rawResultsData = rawResults.data(using: .utf8),
              let parsedResults = try? JSONSerialization.jsonObject(with: rawResultsData) as? [String: Any] else {
            fail("WKWebView reported testReady without valid render-fidelity results.")
            return
        }
        let fixtureError = parsedResults["ok"] as? Bool == true
            ? nil
            : parsedResults["error"] as? String ?? "unknown fixture error"
        guard let widthNumber = state["width"] as? NSNumber,
              let heightNumber = state["height"] as? NSNumber else {
            fail("WKWebView did not report numeric document dimensions.")
            return
        }
        let width = CGFloat(widthNumber.doubleValue)
        let height = CGFloat(heightNumber.doubleValue)
        guard width >= 1, height >= 1, width <= 4_096, height <= 20_000,
              width * height <= 50_000_000 else {
            fail("WKWebView document dimensions are outside the smoke-test budget: \(width) x \(height).")
            return
        }

        let progress = state["progress"] as? [String: Any] ?? [:]
        let coverage = parsedResults["coverage"] as? [String: Any] ?? [:]
        var persistedResults = parsedResults
        persistedResults["webkitHarness"] = [
            "userAgent": state["userAgent"] as? String ?? "unknown",
            "documentWidth": NSNumber(value: Double(width)),
            "documentHeight": NSNumber(value: Double(height)),
            "trace": progress["trace"] as? [String: Any] ?? [:],
            "primaryRasterScale": coverage["primaryRasterScale"] ?? NSNull()
        ]

        do {
            let persistedResultsData = try JSONSerialization.data(
                withJSONObject: persistedResults,
                options: [.prettyPrinted, .sortedKeys]
            )
            try persistedResultsData.write(to: resultsURL, options: .atomic)
            try persistRasterArtifacts(state["rasterArtifacts"])
            try persistHarnessDiagnostics(state["progress"])
        } catch {
            fail("Could not write WKWebView results or raster diagnostics: \(error.localizedDescription)")
            return
        }

        window.setContentSize(NSSize(width: width, height: height))
        webView.setFrameSize(NSSize(width: width, height: height))
        webView.layoutSubtreeIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.takeSnapshot(
                width: width,
                height: height,
                userAgent: state["userAgent"] as? String ?? "unknown",
                fixtureError: fixtureError,
                diagnostics: Self.compactJSONString(state["progress"])
            )
        }
    }

    private func persistRasterArtifacts(_ value: Any?) throws {
        guard let artifacts = value as? [String: Any] else { return }
        let outputDirectory = snapshotURL.deletingLastPathComponent()
        let pngArtifacts = [
            ("oneXPngBase64", "render-fidelity-webkit-raster-1x.png"),
            ("twoXPngBase64", "render-fidelity-webkit-raster-2x.png")
        ]
        for (key, filename) in pngArtifacts {
            guard let encoded = artifacts[key] as? String,
                  let data = Data(base64Encoded: encoded) else {
                throw NSError(
                    domain: "WebKitFidelityHarness",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid \(key) raster diagnostic payload."]
                )
            }
            try data.write(to: outputDirectory.appendingPathComponent(filename), options: .atomic)
        }
        if let metrics = artifacts["metrics"], JSONSerialization.isValidJSONObject(metrics) {
            let data = try JSONSerialization.data(withJSONObject: metrics, options: [.prettyPrinted, .sortedKeys])
            try data.write(
                to: outputDirectory.appendingPathComponent("render-fidelity-webkit-raster-metrics.json"),
                options: .atomic
            )
        }
    }

    private func persistHarnessDiagnostics(_ value: Any?) throws {
        guard let value, JSONSerialization.isValidJSONObject(value) else { return }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(
            to: snapshotURL.deletingLastPathComponent()
                .appendingPathComponent("render-fidelity-webkit-harness-diagnostics.json"),
            options: .atomic
        )
    }

    private func takeSnapshot(
        width: CGFloat,
        height: CGFloat,
        userAgent: String,
        fixtureError: String?,
        diagnostics: String
    ) {
        guard !finished else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = NSRect(x: 0, y: 0, width: width, height: height)
        configuration.snapshotWidth = NSNumber(value: Double(width))
        webView.takeSnapshot(with: configuration) { [weak self] image, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.fail("WKWebView full-page snapshot failed: \(error.localizedDescription)")
                    return
                }
                guard let image,
                      let tiff = image.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: tiff),
                      let png = bitmap.representation(using: .png, properties: [:]) else {
                    self.fail("WKWebView returned an image that could not be encoded as PNG.")
                    return
                }
                do {
                    try png.write(to: self.snapshotURL, options: .atomic)
                } catch {
                    self.fail("Could not write WKWebView snapshot: \(error.localizedDescription)")
                    return
                }
                let artifactSummary = "\(Int(width)) x \(Int(height)), \(png.count) PNG bytes, UA=\(userAgent)"
                if let fixtureError {
                    self.fail(
                        "WKWebView produced results and a full-page snapshot (\(artifactSummary)) " +
                        "but the fixture reported failure: \(fixtureError); diagnostics=\(diagnostics)"
                    )
                } else {
                    self.succeed("WKWebView fidelity smoke passed: \(artifactSummary); diagnostics=\(diagnostics)")
                }
            }
        }
    }

    private static func compactJSONString(_ value: Any?) -> String {
        guard let value,
              JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }

    private func succeed(_ message: String) {
        guard !finished else { return }
        finished = true
        pollTimer?.invalidate()
        timeoutTimer?.invalidate()
        print(message)
        fflush(stdout)
        exit(0)
    }

    private func fail(_ message: String) {
        guard !finished else { return }
        finished = true
        pollTimer?.invalidate()
        timeoutTimer?.invalidate()
        fputs("\(message)\n", stderr)
        fflush(stderr)
        exit(1)
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let harness = WebKitFidelityHarness(
        htmlURL: htmlURL,
        snapshotURL: snapshotURL,
        resultsURL: resultsURL,
        timeoutSeconds: timeoutSeconds
    )
    harness.start()
    withExtendedLifetime(harness) {
        application.run()
    }
}
