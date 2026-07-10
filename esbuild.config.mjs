import { readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const prod = process.argv[2] === "production";
const builtins = Array.from(new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]));
const legalNoticeFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES.txt",
  "fonts/LICENSE-OFL.txt",
  "fonts/FONTLOG.txt"
];
const legalNoticeSections = await Promise.all(
  legalNoticeFiles.map(async (path) => {
    const content = (await readFile(path, "utf8")).trim();
    return `===== ${path} =====\n${content}`;
  })
);
const legalNoticeText = legalNoticeSections.join("\n\n");
if (legalNoticeText.includes("*/")) {
  throw new Error("A bundled legal notice contains a JavaScript comment terminator.");
}
const legalBanner = [
  "/*!",
  " * Mobile PDF Exporter KR — bundled legal notices",
  ...legalNoticeText.split("\n").map((line) => line ? ` * ${line}` : " *"),
  " */"
].join("\n");

const context = await esbuild.context({
  banner: {
    js: legalBanner
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  loader: {
    ".gz": "base64",
    ".jpg": "base64",
    ".png": "base64",
    ".otf": "base64"
  },
  logLevel: "info",
  minify: prod,
  outfile: "main.js",
  platform: "browser",
  sourcemap: prod ? false : "inline",
  target: "es2021",
  treeShaking: true
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  const output = await readFile("main.js", "utf8");
  await writeFile("main.js", output.replace(/[ \t]+$/gm, ""), "utf8");
} else {
  await context.watch();
}
