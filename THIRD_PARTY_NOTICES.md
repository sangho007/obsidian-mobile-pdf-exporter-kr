# Third-party notices

Mobile PDF Exporter KR is based on
[arias007/obsidian-mobile-pdf-exporter](https://github.com/arias007/obsidian-mobile-pdf-exporter)
and retains its MIT license notice in `LICENSE`.

The JavaScript bundle includes these direct runtime libraries:

- [pdf-lib 1.17.1](https://github.com/Hopding/pdf-lib)
- [pdflib-fontkit 1.8.11](https://github.com/znacloud/pdf-fontkit), pinned to
  npm package integrity
  `sha512-J1oiikl5E7en02DGIorof7c5b0JEXXW/DK3Kltv9va72Kn1230eAl1DNSXbcJPAUl0/G2e6UnJWQJoysdyQydA==`
- pako 1.0.11 and pdf-lib's locked dependencies

`pdflib-fontkit` is distributed as a pre-built bundle. It contains additional
MIT, HarfBuzz Old MIT, Apache-2.0, BSD-3-Clause, ISC, Zlib, 0BSD, and
Unicode-DFS-2016 components or derived data that do not all appear in this
project's `package-lock.json`. Their copyright notices, provenance, and
complete license terms are preserved in
`THIRD_PARTY_LICENSES.txt`. The same text is inserted as a readable comment at
the beginning of `main.js` for three-file BRAT installations.

The internal dependency audit uses the published `pdflib-fontkit` ESM bundle
and the upstream `yarn.lock`. The upstream `package-lock.json` records older
versions for some modules (notably `deep-equal`) and is not treated as the
build provenance source.

The bundled Noto Sans CJK KR subset is derived from
[Noto Sans CJK 2.004](https://github.com/notofonts/noto-cjk/tree/523d033d6cb47f4a80c58a35753646f5c3608a78)
and is distributed under SIL Open Font License 1.1. Its full license and
modification record are in `fonts/LICENSE-OFL.txt` and `fonts/FONTLOG.txt`.
Those files are also inserted as readable notices at the beginning of
`main.js` because the bundled font itself is stored there as gzip/base64 data.
