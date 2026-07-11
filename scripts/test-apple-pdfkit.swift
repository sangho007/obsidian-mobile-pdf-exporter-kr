#!/usr/bin/env swift

import CoreGraphics
import Foundation
import PDFKit

guard CommandLine.arguments.count == 2 else {
    fputs("usage: swift scripts/test-apple-pdfkit.swift PDF_PATH\n", stderr)
    exit(2)
}

let pdfURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: pdfURL) else {
    fputs("Apple PDFKit could not open \(pdfURL.path).\n", stderr)
    exit(1)
}
guard document.pageCount == 2,
      let visiblePage = document.page(at: 0),
      let selectablePage = document.page(at: 1) else {
    fputs("Expected exactly two smoke-test pages.\n", stderr)
    exit(1)
}

let selectableText = (selectablePage.string ?? "").precomposedStringWithCanonicalMapping
let requiredPhrases = [
    "한글 선택 테스트:",
    "혼합 문장: Obsidian PDF 2026",
    "옛한글 자모:",
    "한자 혼합: 앞뒤 유지",
    "이모지 혼합: 앞뒤 유지",
    "미지원 문자 혼합: A한글B",
    "인라인 공백: 한글 선택"
]
for phrase in requiredPhrases {
    guard selectableText.contains(phrase.precomposedStringWithCanonicalMapping) else {
        fputs("Apple PDFKit text extraction missed: \(phrase)\nExtracted: \(selectableText)\n", stderr)
        exit(1)
    }
}
for forbidden in ["漢", "字", "😀", "مرحبا"] {
    guard !selectableText.contains(forbidden) else {
        fputs("Unsupported glyph leaked into Apple PDFKit selectable text: \(forbidden)\n", stderr)
        exit(1)
    }
}

let matches = document.findString("인라인 공백: 한글 선택", withOptions: [])
guard matches.count == 1,
      matches[0].pages.contains(where: { $0 === selectablePage }),
      matches[0].string?.precomposedStringWithCanonicalMapping == "인라인 공백: 한글 선택" else {
    fputs("Apple PDFKit search/selection did not return the exact hidden Korean phrase once.\n", stderr)
    exit(1)
}

func nonWhitePixelCount(_ page: PDFPage, scale: CGFloat = 1.0) -> Int {
    let bounds = page.bounds(for: .mediaBox)
    let width = max(1, Int(ceil(bounds.width * scale)))
    let height = max(1, Int(ceil(bounds.height * scale)))
    let bytesPerRow = width * 4
    let capacity = bytesPerRow * height
    let pixels = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
    defer { pixels.deallocate() }
    pixels.initialize(repeating: 255, count: capacity)

    guard let context = CGContext(
        data: pixels,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return Int.max
    }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()

    var count = 0
    for offset in stride(from: 0, to: capacity, by: 4) {
        if pixels[offset] < 248 || pixels[offset + 1] < 248 || pixels[offset + 2] < 248 {
            count += 1
        }
    }
    return count
}

let visibleInk = nonWhitePixelCount(visiblePage)
let hiddenInk = nonWhitePixelCount(selectablePage)
guard visibleInk > 500 else {
    fputs("Apple PDFKit rendered the visible Korean page as blank (\(visibleInk) ink pixels).\n", stderr)
    exit(1)
}
guard hiddenInk == 0 else {
    fputs("Opacity-zero selectable text became visible in Apple PDFKit (\(hiddenInk) ink pixels).\n", stderr)
    exit(1)
}

print("Apple PDFKit verified hidden Korean search/selection and zero visible ghost pixels.")
