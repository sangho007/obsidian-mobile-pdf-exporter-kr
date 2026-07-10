import type { PDFFont } from "pdf-lib";

const pdfCharacterSetCache = new WeakMap<PDFFont, Set<number>>();

export function getEncodablePdfText(font: PDFFont, text: string): string {
  if (!text) return "";
  if (canEncodePdfText(font, text)) return text;

  // Preserve every character the embedded font can represent. Script-based
  // regular-expression fallbacks used by the upstream plugin dropped valid
  // Hangul whenever the same DOM fragment also contained one unsupported emoji.
  return filterEncodablePdfChars(font, text);
}

export function canEncodePdfText(font: PDFFont, text: string): boolean {
  const characterSet = getFontCharacterSet(font);
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !characterSet.has(codePoint)) return false;
  }

  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

export function filterEncodablePdfChars(font: PDFFont, text: string): string {
  let filtered = "";
  for (const char of text) {
    if (canEncodePdfChar(font, char)) filtered += char;
  }
  return filtered.trim();
}

function canEncodePdfChar(font: PDFFont, char: string): boolean {
  return canEncodePdfText(font, char);
}

function getFontCharacterSet(font: PDFFont): Set<number> {
  let characterSet = pdfCharacterSetCache.get(font);
  if (!characterSet) {
    characterSet = new Set(font.getCharacterSet());
    pdfCharacterSetCache.set(font, characterSet);
  }
  return characterSet;
}
