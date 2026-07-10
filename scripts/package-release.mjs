#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const manifest = JSON.parse(readFileSync(resolve("manifest.json"), "utf8"));
const releaseFolderName = manifest.id;
const releaseBaseName = `${manifest.id}-${manifest.version}`;
const distDir = resolve("dist");
const releaseDir = resolve(distDir, releaseFolderName);
const zipPath = resolve(distDir, `${releaseBaseName}.zip`);

const releaseFiles = [
  ["main.js", "main.js"],
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"],
  ["README.md", "README.md"],
  ["LICENSE", "LICENSE"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["THIRD_PARTY_LICENSES.txt", "THIRD_PARTY_LICENSES.txt"],
  ["fonts/LICENSE-OFL.txt", "fonts/LICENSE-OFL.txt"],
  ["fonts/FONTLOG.txt", "fonts/FONTLOG.txt"],
  [
    "fonts/NotoSansCJKkr-Regular.ko-subset.ttf",
    "fonts/NotoSansCJKkr-Regular.ko-subset.ttf"
  ]
];

rmSync(releaseDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });

for (const [source, destination] of releaseFiles) {
  const target = resolve(releaseDir, destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(source), target);
}

const zip = spawnSync("zip", ["-q", "-r", zipPath, releaseFolderName], {
  cwd: distDir,
  encoding: "utf8"
});
if (zip.error) throw new Error(`zip could not run: ${zip.error.message}`);
if (zip.status !== 0) {
  process.stderr.write(zip.stderr || zip.stdout || "zip failed\n");
  process.exit(zip.status ?? 1);
}

process.stdout.write(
  [
    `Created ${releaseDir}`,
    `Created ${zipPath} (${statSync(zipPath).size} bytes)`
  ].join("\n") + "\n"
);
