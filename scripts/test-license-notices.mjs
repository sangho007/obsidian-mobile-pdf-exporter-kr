#!/usr/bin/env node

import { readFileSync } from "node:fs";

const legalNoticeFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES.txt",
  "fonts/LICENSE-OFL.txt",
  "fonts/FONTLOG.txt"
];
const legalNoticeText = legalNoticeFiles
  .map((path) => `===== ${path} =====\n${readFileSync(path, "utf8").trim()}`)
  .join("\n\n");
const expectedBanner = [
  "/*!",
  " * Mobile PDF Exporter KR — bundled legal notices",
  ...legalNoticeText.split("\n").map((line) => line ? ` * ${line}` : " *"),
  " */"
].join("\n");
const main = readFileSync("main.js", "utf8");
if (!main.startsWith(expectedBanner)) {
  throw new Error("main.js does not preserve the complete legal notice banner.");
}

const requiredMarkers = [
  "Copyright (c) 2026 Murat / Codex",
  "Copyright (c) 2019 Andrew Dillon",
  "Copyright (c) Microsoft Corporation",
  "Copyright 2013 Google Inc. All Rights Reserved.",
  "Apache License",
  "Copyright 2008 Fair Oaks Labs, Inc.",
  "Jean-loup Gailly and Mark Adler",
  "Copyright (c) Isaac Z. Schlueter",
  "HarfBuzz is licensed under the so-called",
  "Copyright © 1991-2016 Unicode, Inc.",
  "deep-equal 1.1.1",
  "es-abstract 1.17.5",
  "Lodash 4.17.15",
  "Copyright (c) 2012, 2013, 2014 James Halliday",
  "Copyright (c) 2014 Jordan Harband",
  "Copyright OpenJS Foundation and other contributors",
  "Reserved Font Name 'Source'",
  "SIL OPEN FONT LICENSE"
];
for (const marker of requiredMarkers) {
  if (!main.includes(marker)) throw new Error(`main.js is missing legal marker: ${marker}`);
}
if (main.includes("deep-equal 1.0.1")) {
  throw new Error("main.js contains the stale deep-equal 1.0.1 provenance notice.");
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
for (const [name, version] of Object.entries({
  pako: "1.0.11",
  "pdf-lib": "1.17.1",
  "pdflib-fontkit": "1.8.11"
})) {
  if (packageJson.dependencies?.[name] !== version) {
    throw new Error(`${name} must remain pinned to ${version} for the audited notices.`);
  }
}

process.stdout.write(
  `Verified the complete main.js legal banner and ${requiredMarkers.length} license sentinels.\n`
);
