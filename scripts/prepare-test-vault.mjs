#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const vaultPath = resolve(process.argv[2] ?? `tmp/obsidian-render-vault-${Date.now()}`);
if (existsSync(vaultPath) && readdirSync(vaultPath).length > 0) {
  throw new Error(`Refusing to reuse a non-empty test vault: ${vaultPath}`);
}
const pluginPath = resolve(vaultPath, ".obsidian/plugins/mobile-pdf-exporter-kr");
mkdirSync(pluginPath, { recursive: true });
cpSync(resolve("tests/fixtures"), vaultPath, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  writeFileSync(resolve(pluginPath, file), readFileSync(resolve(file)));
}
writeFileSync(
  resolve(pluginPath, "data.json"),
  `${JSON.stringify({
    language: "ko",
    outputFolder: "PDF Exports",
    marginMm: 7,
    includeTitle: true,
    shareAfterExport: false,
    openAfterExport: false,
    noteExportMode: "selectable",
    pagePreset: "a4",
    pageOrientation: "portrait",
    colorMode: "color",
    contentScalePercent: 100,
    imageRasterScale: 2
  }, null, 2)}\n`
);
writeFileSync(
  resolve(vaultPath, ".obsidian/community-plugins.json"),
  `${JSON.stringify(["mobile-pdf-exporter-kr"], null, 2)}\n`
);
writeFileSync(
  resolve(vaultPath, ".obsidian/app.json"),
  `${JSON.stringify({ defaultViewMode: "preview", readableLineLength: false, showLineNumber: false }, null, 2)}\n`
);
writeFileSync(
  resolve(vaultPath, ".obsidian/appearance.json"),
  `${JSON.stringify({ baseFontSize: 16, theme: "moonstone" }, null, 2)}\n`
);
process.stdout.write(`${vaultPath}\n`);
