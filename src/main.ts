import {
  App,
  Component,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath
} from "obsidian";
import type { Color, PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import pako from "pako";
import embeddedKoreanFontGzipBase64 from "../fonts/NotoSansCJKkr-Regular.ko-subset.ttf.gz";
import supportCode1Base64 from "./generated/support-code-1.jpg";
import supportCode2Base64 from "./generated/support-code-2.png";
import { prepareDomSnapshot } from "./dom-snapshot";
import type { PreparedDomSnapshot } from "./dom-snapshot";
import {
  canvasToPngBytes,
  getSafeDocumentRasterScale,
  rasterizeImageToPngBytes
} from "./media-raster";
import { canEncodePdfText, getEncodablePdfText } from "./pdf-text";
import {
  buildEncodablePositionedRuns,
  clampPageBreakToPhysicalPage,
  fitTextSizeToWidth,
  getFixedPageSliceLayout,
  isRenderedLeadingWhitespaceBoundaryCompatible,
  isRenderedTrailingWhitespaceBoundaryCompatible,
  isTextMergeGeometryCompatible,
  isRenderedWhitespaceBoundaryCompatible,
  measureRenderedWhitespaceSeparator,
  segmentTextGraphemes,
  startsInsidePageBreakInterval,
  verticalCenterBelongsToPage as textCenterBelongsToPage
} from "./text-layout";

const UI_LANGUAGES = ["auto", "ko", "zh", "en"] as const;
type UiLanguage = typeof UI_LANGUAGES[number];
type ResolvedUiLanguage = Exclude<UiLanguage, "auto">;

const NOTE_PDF_EXPORT_MODES = ["selectable", "image"] as const;
type NotePdfExportMode = typeof NOTE_PDF_EXPORT_MODES[number];

const PDF_PAGE_PRESETS = ["mobile", "a4", "a5", "letter"] as const;
type PdfPagePreset = typeof PDF_PAGE_PRESETS[number];

const PDF_ORIENTATIONS = ["portrait", "landscape"] as const;
type PdfOrientation = typeof PDF_ORIENTATIONS[number];

const PDF_COLOR_MODES = ["color", "grayscale"] as const;
type PdfColorMode = typeof PDF_COLOR_MODES[number];

interface MobilePdfExporterSettings {
  language: UiLanguage;
  outputFolder: string;
  marginMm: number;
  includeTitle: boolean;
  shareAfterExport: boolean;
  openAfterExport: boolean;
  noteExportMode: NotePdfExportMode;
  pagePreset: PdfPagePreset;
  pageOrientation: PdfOrientation;
  colorMode: PdfColorMode;
  contentScalePercent: number;
  imageRasterScale: number;
}

interface RenderedPreview {
  rootEl: HTMLElement;
  pageEl: HTMLElement;
  renderComponent: Component;
}

interface ExportFileOptions {
  outputBaseName?: string;
  busyPrompt?: PdfExportBusyPrompt;
}

interface TextFragment {
  text: string;
  graphemes: TextGraphemeFragment[];
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSizePx: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: Color;
  underline: boolean;
  href: string | null;
  mergeContainer: Element;
}

interface TextLineDraft {
  text: string;
  graphemes: TextGraphemeFragment[];
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSizePx: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: Color;
  underline: boolean;
  href: string | null;
  mergeContainer: Element;
}

interface TextGraphemeFragment {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ImageFragment {
  element: HTMLImageElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CanvasFragment {
  element: HTMLCanvasElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface LinkFragment {
  href: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface BoxFragment {
  left: number;
  top: number;
  right: number;
  bottom: number;
  background: Color | null;
  border: Color | null;
}

interface SvgFragment {
  element: SVGSVGElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type DecorationKind = "checkbox" | "bullet" | "marker" | "text";

interface DecorationFragment {
  kind: DecorationKind;
  left: number;
  top: number;
  right: number;
  bottom: number;
  color: Color;
  border: Color | null;
  checked?: boolean;
  text?: string;
  fontSizePx: number;
}

interface KeepBlockFragment {
  left: number;
  top: number;
  right: number;
  bottom: number;
  priority: number;
}

interface PdfPageSizeMm {
  width: number;
  height: number;
}

interface PreviewPdfModel {
  ownerDocument: Document;
  pageEl: HTMLElement;
  pageWidthPt: number;
  pageHeightPt: number;
  sourceWidthPx: number;
  pxToPt: number;
  pageHeightPx: number;
  background: Color;
  backgroundCss: string;
  boxFragments: BoxFragment[];
  textFragments: TextFragment[];
  imageFragments: ImageFragment[];
  canvasFragments: CanvasFragment[];
  linkFragments: LinkFragment[];
  svgFragments: SvgFragment[];
  decorationFragments: DecorationFragment[];
  keepBlocks: KeepBlockFragment[];
  contentHeightPx: number;
  pageBreaks: number[];
}

interface ExcalidrawAutomateRuntime {
  getAPI?: () => ExcalidrawAutomateRuntime;
  reset?: () => void;
  destroy?: () => void;
  createSVG?: (
    templatePath?: string,
    embedFont?: boolean,
    exportSettings?: unknown,
    loader?: unknown,
    theme?: string,
    padding?: number,
    convertMarkdownLinksToObsidianURLs?: boolean,
    includeInternalLinks?: boolean
  ) => Promise<SVGSVGElement>;
  createPNG?: (
    templatePath?: string,
    scale?: number,
    exportSettings?: unknown,
    loader?: unknown,
    theme?: string,
    padding?: number
  ) => Promise<Blob>;
  getExportSettings?: (withBackground: boolean, withTheme: boolean, isMask?: boolean) => unknown;
  getEmbeddedFilesLoader?: (isDark?: boolean) => unknown;
}

interface ExcalidrawAutomateLease {
  api: ExcalidrawAutomateRuntime;
  destroyAfterUse: boolean;
}

interface NoteDoodlePoint {
  x: number;
  y: number;
  t: number;
}

interface NoteDoodleStroke {
  brush: "pen" | "watercolor";
  color: string;
  width: number;
  opacity: number;
  count: number;
  points: NoteDoodlePoint[];
}

interface NoteDoodleData {
  version: number;
  sourcePath: string;
  strokes: NoteDoodleStroke[];
  updatedAt: string | null;
}

interface NoteDoodleOverlaySource {
  data: NoteDoodleData | null;
  canvas: HTMLCanvasElement | null;
  surface: HTMLElement;
  kind: "note-doodle" | "notedraw";
  score: number;
}

interface LiveDrawingController {
  file?: TFile;
  doodleData?: unknown;
  drawingData?: unknown;
  canvas?: HTMLCanvasElement | null;
  render?: () => void;
  active?: boolean;
  surfaceType?: string;
}

const UI_TEXT = {
  ko: {
    ribbonTitle: "미리보기 PDF 내보내기",
    commandName: "Mobile PDF Exporter KR: 현재 노트를 미리보기 PDF로 내보내기",
    noMarkdownNotice: "먼저 Markdown 노트를 여세요.",
    optionsTitle: "PDF 내보내기 옵션",
    exportModeName: "내보내기 방식",
    exportModeDesc: "선택 가능 텍스트는 검색과 복사에 적합하고, 이미지 PDF는 화면 모양을 고정해서 보존합니다.",
    exportModeSelectable: "선택 가능 텍스트",
    exportModeImage: "이미지 PDF",
    pageSizeName: "페이지 크기",
    orientationName: "방향",
    orientationPortrait: "세로",
    orientationLandscape: "가로",
    colorName: "색상",
    colorOption: "컬러",
    grayscaleOption: "회색조",
    marginName: "여백",
    contentScaleName: "내용 배율",
    imageQualityName: "이미지 PDF 품질",
    imageQualityDesc: "일반 노트의 이미지 PDF에만 적용됩니다. 품질이 높을수록 파일이 커집니다.",
    imageQualityStandard: "표준 / 작은 파일",
    imageQualityClear: "선명 / 권장",
    imageQualityHigh: "고화질",
    imageQualityUltra: "최고화질 / 큰 파일",
    includeTitleName: "노트 제목 포함",
    openAfterExportName: "내보낸 뒤 PDF 열기",
    shareAfterExportName: "모바일 공유 시트 표시",
    saveAsDefaultName: "기본값으로 저장",
    saveAsDefaultDesc: "이번 선택을 다음 내보내기의 기본 옵션으로 저장합니다.",
    outputFolderName: "출력 폴더",
    outputFolderDesc: "PDF를 볼트 안의 이 폴더에 저장합니다.",
    pdfNameLabel: "PDF 이름",
    exportPdfButton: "PDF 내보내기",
    cancelButton: "취소",
    busyExporting: "PDF 내보내는 중",
    busyCompleteTitle: "내보내기 완료",
    busyCompleteStatus: "완료",
    busyFailedTitle: "PDF 내보내기 실패",
    settingsIntro: "메뉴와 버튼을 누르면 PDF 내보내기 옵션이 먼저 열립니다. 일반 Markdown 노트는 선택 가능 텍스트 또는 이미지 PDF로 내보낼 수 있습니다.",
    settingsGeneralHeading: "일반",
    settingsNoteOptionsHeading: "일반 노트 PDF 옵션",
    pageSizeDesc: "모바일 긴 페이지는 휴대폰 읽기에 적합하고, A4/A5/Letter는 인쇄와 보관에 적합합니다.",
    orientationDesc: "가로 방향은 페이지 너비와 높이를 서로 바꿉니다.",
    colorDesc: "회색조는 인쇄에 적합하고, 컬러는 테마·링크·이미지 색상을 유지합니다.",
    settingsSaveAndShareHeading: "저장 및 공유",
    languageName: "인터페이스 언어",
    languageDesc: "자동은 Obsidian 언어를 따릅니다. 내보내기 버튼, 메뉴, 명령, 옵션과 안내에 선택한 언어를 사용합니다.",
    languageAuto: "자동 / Obsidian 언어 따르기",
    languageKorean: "한국어",
    languageChinese: "중국어",
    languageEnglish: "영어",
    codesTitle: "커피 한 잔 후원",
    codesSubtitle: "이 도구가 도움이 되었다면 원저자의 유지보수를 후원할 수 있습니다.",
    shareFailedNotice: "PDF는 저장했지만 시스템 공유 시트를 열지 못했습니다.",
    fontMissingError: "포함된 PDF용 한글 글꼴을 읽지 못했습니다. 전체 플러그인 ZIP을 다시 설치하거나 fonts/NotoSansCJKkr-Regular.ko-subset.ttf 파일을 확인하세요.",
    uniqueFileNameError: "고유한 PDF 파일 이름을 만들지 못했습니다.",
    excalidrawApiMissingError: "Excalidraw 내보내기 API를 찾지 못했습니다. Excalidraw 플러그인이 켜져 있는지 확인하세요.",
    excalidrawExportFailedError: "Excalidraw 이미지가 너무 크거나 내보내기에 실패했습니다. 낮은 해상도와 페이지 분할도 이미 시도했습니다.",
    excalidrawPreviewUnavailable: "Excalidraw 미리보기를 사용할 수 없어 원본 데이터를 건너뛰었습니다.",
    previewNoExportSizeError: "미리보기 영역에 내보낼 수 있는 크기가 없습니다.",
    previewNoContentError: "미리보기에 내보낼 수 있는 내용이 없습니다.",
    previewTooLargeError: "노트가 iPad 안전 메모리 한도를 넘습니다. 노트를 나누거나 페이지 수를 줄인 뒤 다시 내보내세요."
  },
  zh: {
    ribbonTitle: "导出预览版 PDF",
    commandName: "Mobile PDF Exporter: 导出当前笔记为预览版 PDF",
    noMarkdownNotice: "先打开一个 Markdown 笔记。",
    optionsTitle: "PDF 导出选项",
    exportModeName: "导出方式",
    exportModeDesc: "可复制文字版适合阅读、检索、复制；图片版适合保持视觉固定。",
    exportModeSelectable: "可复制文字版",
    exportModeImage: "图片版",
    pageSizeName: "页面大小",
    orientationName: "方向",
    orientationPortrait: "竖向",
    orientationLandscape: "横向",
    colorName: "色彩",
    colorOption: "彩色",
    grayscaleOption: "灰度",
    marginName: "页边距",
    contentScaleName: "内容缩放",
    imageQualityName: "图片版清晰度",
    imageQualityDesc: "只影响图片版普通笔记 PDF；越高清文件越大。",
    imageQualityStandard: "标准 / 小文件",
    imageQualityClear: "清晰 / 推荐",
    imageQualityHigh: "高清",
    imageQualityUltra: "超清 / 大文件",
    includeTitleName: "包含笔记标题",
    openAfterExportName: "导出后打开",
    shareAfterExportName: "导出后分享",
    saveAsDefaultName: "保存为默认",
    saveAsDefaultDesc: "勾选后，本次选项会写入插件设置，作为下次默认值。",
    outputFolderName: "输出文件夹",
    outputFolderDesc: "PDF 保存到库里的这个文件夹。",
    pdfNameLabel: "PDF 名称",
    exportPdfButton: "导出 PDF",
    cancelButton: "取消",
    busyExporting: "正在导出 PDF",
    busyCompleteTitle: "导出完成",
    busyCompleteStatus: "完成",
    busyFailedTitle: "PDF 导出失败",
    settingsIntro: "菜单和按钮会先打开 PDF 导出选项；普通 Markdown 笔记可选择可复制文字版或图片版。",
    settingsGeneralHeading: "通用",
    settingsNoteOptionsHeading: "普通笔记 PDF 选项",
    pageSizeDesc: "手机长页适合手机阅读；A4/A5/Letter 适合打印和归档。",
    orientationDesc: "横向会交换页面宽高。",
    colorDesc: "灰度适合打印、减小颜色干扰；彩色会保留主题色、链接色和图片颜色。",
    settingsSaveAndShareHeading: "保存和分享",
    languageName: "界面语言",
    languageDesc: "Auto 会跟随 Obsidian 语言；导出按钮、菜单、命令、选项面板和提示会使用所选语言。",
    languageAuto: "Auto / 跟随 Obsidian",
    languageKorean: "한국어",
    languageChinese: "中文",
    languageEnglish: "English",
    codesTitle: "给我买咖啡",
    codesSubtitle: "如果这个插件帮到你，可以扫码打赏支持继续维护。",
    shareFailedNotice: "PDF 已保存，但系统分享面板没有打开。",
    fontMissingError: "缺少 PDF 韩文字体。请重新安装完整插件包，或把 NotoSansCJKkr-Regular.ko-subset.ttf 放入插件目录的 fonts 文件夹。",
    uniqueFileNameError: "无法生成唯一 PDF 文件名。",
    excalidrawApiMissingError: "没有找到 Excalidraw 导出接口，请确认 Excalidraw 插件已启用。",
    excalidrawExportFailedError: "Excalidraw 图片过大或导出失败，已尝试降低分辨率和分页切片。",
    excalidrawPreviewUnavailable: "Excalidraw 预览暂不可用，已跳过源码数据。",
    previewNoExportSizeError: "预览层没有可导出的尺寸。",
    previewNoContentError: "预览没有可导出的内容。",
    previewTooLargeError: "笔记超过了 iPad 的安全内存限制。请拆分笔记或减少页数后再导出。"
  },
  en: {
    ribbonTitle: "Export preview PDF",
    commandName: "Mobile PDF Exporter: Export preview PDF",
    noMarkdownNotice: "Open a Markdown note first.",
    optionsTitle: "PDF export options",
    exportModeName: "Export mode",
    exportModeDesc: "Selectable text is best for reading, search, and copy; image PDF keeps a fixed visual layout.",
    exportModeSelectable: "Selectable text",
    exportModeImage: "Image PDF",
    pageSizeName: "Page size",
    orientationName: "Orientation",
    orientationPortrait: "Portrait",
    orientationLandscape: "Landscape",
    colorName: "Color",
    colorOption: "Color",
    grayscaleOption: "Grayscale",
    marginName: "Margin",
    contentScaleName: "Content scale",
    imageQualityName: "Image PDF quality",
    imageQualityDesc: "Only affects ordinary-note image PDFs. Higher quality creates larger files.",
    imageQualityStandard: "Standard / smaller file",
    imageQualityClear: "Clear / recommended",
    imageQualityHigh: "High",
    imageQualityUltra: "Ultra / large file",
    includeTitleName: "Include note title",
    openAfterExportName: "Open PDF after export",
    shareAfterExportName: "Show mobile share sheet",
    saveAsDefaultName: "Save as default",
    saveAsDefaultDesc: "Save these choices as the default plugin settings.",
    outputFolderName: "Output folder",
    outputFolderDesc: "Save PDFs to this folder inside the vault.",
    pdfNameLabel: "PDF name",
    exportPdfButton: "Export PDF",
    cancelButton: "Cancel",
    busyExporting: "Exporting PDF",
    busyCompleteTitle: "Export complete",
    busyCompleteStatus: "Done",
    busyFailedTitle: "PDF export failed",
    settingsIntro: "Menus and buttons open the PDF export options first. Ordinary Markdown notes can export as selectable-text PDFs or image PDFs.",
    settingsGeneralHeading: "General",
    settingsNoteOptionsHeading: "Ordinary note PDF options",
    pageSizeDesc: "Mobile long page is good for phone reading. A4/A5/Letter are useful for printing and archiving.",
    orientationDesc: "Landscape swaps the page width and height.",
    colorDesc: "Grayscale is useful for printing; color keeps theme colors, link colors, and image colors.",
    settingsSaveAndShareHeading: "Save and share",
    languageName: "Interface language",
    languageDesc: "Auto follows Obsidian's language. Export buttons, menus, commands, options, and prompts use the selected language.",
    languageAuto: "Auto / follow Obsidian",
    languageKorean: "Korean",
    languageChinese: "Chinese",
    languageEnglish: "English",
    codesTitle: "Buy me a coffee",
    codesSubtitle: "If this tool helps, tips are appreciated and support ongoing maintenance.",
    shareFailedNotice: "The PDF was saved, but the system share sheet did not open.",
    fontMissingError: "Missing Korean PDF font. Reinstall the complete plugin package, or place NotoSansCJKkr-Regular.ko-subset.ttf in the plugin fonts folder.",
    uniqueFileNameError: "Could not generate a unique PDF filename.",
    excalidrawApiMissingError: "Excalidraw export API was not found. Make sure the Excalidraw plugin is enabled.",
    excalidrawExportFailedError: "The Excalidraw image was too large or export failed. Lower resolutions and page slicing were already tried.",
    excalidrawPreviewUnavailable: "Excalidraw preview is unavailable, so source data was skipped.",
    previewNoExportSizeError: "The preview layer has no exportable size.",
    previewNoContentError: "The preview has no exportable content.",
    previewTooLargeError: "The note exceeds the safe iPad memory budget. Split the note or reduce its page count, then export again."
  }
} as const;

type TranslationKey = keyof typeof UI_TEXT.en;

const DEFAULT_SETTINGS: MobilePdfExporterSettings = {
  language: "auto",
  outputFolder: "PDF Exports",
  marginMm: 7,
  includeTitle: true,
  shareAfterExport: true,
  openAfterExport: false,
  noteExportMode: "selectable",
  pagePreset: "mobile",
  pageOrientation: "portrait",
  colorMode: "color",
  contentScalePercent: 100,
  imageRasterScale: 1.5
};

const PDF_PAGE_SIZES_MM: Record<PdfPagePreset, PdfPageSizeMm> = {
  mobile: { width: 104, height: 225 },
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
  letter: { width: 215.9, height: 279.4 }
};

const PDF_PAGE_LABELS: Record<PdfPagePreset, string> = {
  mobile: "手机长页 104 x 225 mm",
  a4: "A4 210 x 297 mm",
  a5: "A5 148 x 210 mm",
  letter: "Letter 8.5 x 11 in"
};

const PDF_SUBJECT = "Selectable preview PDF exported from Obsidian";
const IMAGE_PDF_SUBJECT = "Image preview PDF exported from Obsidian";
const EXCALIDRAW_IMAGE_PDF_SUBJECT = "Image PDF exported from Obsidian Excalidraw";
const MAX_SVG_FRAGMENTS_PER_PAGE = 24;
const SVG_IMAGE_LOAD_TIMEOUT_MS = 1800;
const IMAGE_WAIT_TIMEOUT_MS = 2500;
const PREVIEW_RENDER_TIMEOUT_MS = 12000;
const EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS = 45000;
const EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS = 15000;
const EXCALIDRAW_MIN_EXPORT_SCALE = 0.5;
const EXCALIDRAW_PREFERRED_MAX_PNG_BYTES = 24 * 1024 * 1024;
const EXCALIDRAW_MAX_SLICE_WIDTH_PX = 4096;
const EXCALIDRAW_MAX_SLICE_HEIGHT_PX = 8192;
const EXCALIDRAW_MAX_SLICE_PIXELS = 16_000_000;
const PREVIEW_IMAGE_MAX_CANVAS_PIXELS = 12_000_000;
const PREVIEW_IMAGE_MAX_CANVAS_DIMENSION = 4096;
const PREVIEW_PAGE_MAX_PNG_BYTES = 32 * 1024 * 1024;
const PREVIEW_DOCUMENT_MAX_RASTER_PIXELS = 20_000_000;
const PREVIEW_DOCUMENT_MAX_PNG_BYTES = 64 * 1024 * 1024;
const PREVIEW_DOCUMENT_MIN_RASTER_SCALE = 0.5;
const COMPAT_IMAGE_MAX_CANVAS_PIXELS = 4_000_000;
const COMPAT_IMAGE_MAX_CANVAS_DIMENSION = 3072;
const COMPAT_IMAGE_MAX_PNG_BYTES = 16 * 1024 * 1024;
const FRAME_WAIT_TIMEOUT_MS = 120;
const BUSY_PROMPT_PAINT_WAIT_MS = 80;
const PAGE_BREAK_PADDING_PX = 8;
const PAGE_BREAK_MIN_ADVANCE_PX = 72;
const SELECTABLE_PREVIEW_BACKGROUND_MIN_SCALE = 2;
const SELECTABLE_TEXT_LAYER_OPACITY = 0;
const TASK_CHECKBOX_VERTICAL_SHIFT_EM = 0.22;
const NOTE_DOODLE_MAX_PEN_COUNT = 5;
const NOTE_DOODLE_DEFAULT_OPACITY = 1;
const NOTE_DOODLE_WATERCOLOR = "watercolor";
const KOREAN_FONT_ASSET_FILE = "NotoSansCJKkr-Regular.ko-subset.ttf";
const LOCAL_KOREAN_FONT_CANDIDATES = [
  `fonts/${KOREAN_FONT_ASSET_FILE}`,
  KOREAN_FONT_ASSET_FILE,
  "fonts/NotoSansKR-Regular.ttf",
  "fonts/NotoSansCJKkr-Regular.otf"
] as const;
const SETTINGS_EXTRA_CODE_ASSETS = [
  { src: `data:image/jpeg;base64,${supportCode1Base64}`, label: "给我买咖啡 / Buy me a coffee", fileName: "buy-me-a-coffee.jpg" },
  { src: `data:image/png;base64,${supportCode2Base64}`, label: "支持继续维护 / Support this tool", fileName: "support-this-tool.png" }
] as const;

function resolveUiLanguage(language: UiLanguage): ResolvedUiLanguage {
  if (language === "ko" || language === "zh" || language === "en") return language;
  const browserLanguage = (window.navigator.language || "").toLowerCase();
  const browserLanguages = (window.navigator.languages || []).map((item) => item.toLowerCase());
  const languages = [browserLanguage, ...browserLanguages];
  if (languages.some((item) => item.startsWith("ko"))) return "ko";
  return languages.some((item) => item.startsWith("zh")) ? "zh" : "en";
}

function translate(language: ResolvedUiLanguage, key: TranslationKey): string {
  return UI_TEXT[language][key];
}

function getPageLabel(preset: PdfPagePreset, language: ResolvedUiLanguage): string {
  if (language === "zh") return PDF_PAGE_LABELS[preset];
  if (language === "ko") {
    switch (preset) {
      case "mobile":
        return "모바일 긴 페이지 104 x 225 mm";
      case "a4":
        return "A4 210 x 297 mm";
      case "a5":
        return "A5 148 x 210 mm";
      case "letter":
        return "Letter 8.5 x 11 in";
    }
  }
  switch (preset) {
    case "mobile":
      return "Mobile long page 104 x 225 mm";
    case "a4":
      return "A4 210 x 297 mm";
    case "a5":
      return "A5 148 x 210 mm";
    case "letter":
      return "Letter 8.5 x 11 in";
  }
}

function formatBusyElapsed(language: ResolvedUiLanguage, seconds: number): string {
  if (language === "zh") {
    return seconds >= 8
      ? `已用 ${seconds} 秒，仍在处理，请不要关闭 Obsidian。`
      : `已用 ${seconds} 秒`;
  }
  if (language === "ko") {
    return seconds >= 8
      ? `${seconds}초 경과. 아직 처리 중이니 Obsidian을 닫지 마세요.`
      : `${seconds}초 경과`;
  }
  return seconds >= 8
    ? `${seconds}s elapsed. Still working; do not close Obsidian.`
    : `${seconds}s elapsed`;
}

type RegisteredFontkit = Parameters<PDFDocument["registerFontkit"]>[0];
type FontkitModuleShape = Partial<RegisteredFontkit> & { default?: Partial<RegisteredFontkit> };
type PdfLibRuntime = typeof import("pdf-lib");
type PdfFontkitRuntime = typeof import("pdflib-fontkit");
interface PdfRuntime {
  PDFDocument: PdfLibRuntime["PDFDocument"];
  PDFString: PdfLibRuntime["PDFString"];
  StandardFonts: PdfLibRuntime["StandardFonts"];
  rgb: PdfLibRuntime["rgb"];
  fontkitModule: PdfFontkitRuntime;
}

interface ExportFont {
  font: PDFFont;
  supportsUnicode: boolean;
}

let pdfRuntimePromise: Promise<PdfRuntime> | null = null;
let pdfStringRuntime: PdfLibRuntime["PDFString"] | null = null;
let exportableElementCache: WeakMap<Element, boolean> | null = null;
let rgb: PdfLibRuntime["rgb"] = ((red: number, green: number, blue: number) => ({
  type: "RGB",
  red,
  green,
  blue
}) as Color) as PdfLibRuntime["rgb"];

async function loadPdfRuntime(): Promise<PdfRuntime> {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([import("pdf-lib"), import("pdflib-fontkit")]).then(([pdfLib, fontkit]) => {
      const runtime: PdfRuntime = {
        PDFDocument: pdfLib.PDFDocument,
        PDFString: pdfLib.PDFString,
        StandardFonts: pdfLib.StandardFonts,
        rgb: pdfLib.rgb,
        fontkitModule: fontkit
      };
      rgb = runtime.rgb;
      pdfStringRuntime = runtime.PDFString;
      return runtime;
    });
  }
  return pdfRuntimePromise;
}

function getPdfStringRuntime(): PdfLibRuntime["PDFString"] {
  if (!pdfStringRuntime) {
    throw new Error("PDF 引擎尚未加载。");
  }
  return pdfStringRuntime;
}

export default class MobilePdfExporterPlugin extends Plugin {
  settings: MobilePdfExporterSettings = DEFAULT_SETTINGS;
  private fontBytesPromise: Promise<ArrayBuffer> | null = null;
  private ribbonIconEl: HTMLElement | null = null;
  private exportCommand: { name: string } | null = null;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());

    this.ribbonIconEl = this.addRibbonIcon("file-output", this.t("ribbonTitle"), () => {
      void this.exportCurrentFile();
    });

    this.exportCommand = this.addCommand({
      id: "export-current-note-preview-pdf",
      name: this.t("commandName"),
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) this.openExportOptionsModal(file);
        return true;
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
        menu.addItem((item) => {
          item
            .setTitle(this.t("ribbonTitle"))
            .setIcon("file-output")
            .onClick(() => this.openExportOptionsModal(file));
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return;
        menu.addItem((item) => {
          item
            .setTitle(this.t("ribbonTitle"))
            .setIcon("file-output")
            .onClick(() => this.openExportOptionsModal(file));
        });
      })
    );

    this.addSettingTab(new MobilePdfExporterSettingTab(this.app, this));
    this.refreshLocalizedActions();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getResolvedLanguage(): ResolvedUiLanguage {
    return resolveUiLanguage(this.settings.language);
  }

  t(key: TranslationKey): string {
    return translate(this.getResolvedLanguage(), key);
  }

  refreshLocalizedActions(): void {
    const title = this.t("ribbonTitle");
    this.ribbonIconEl?.setAttribute("aria-label", title);
    this.ribbonIconEl?.setAttribute("title", title);
    if (this.exportCommand) this.exportCommand.name = this.t("commandName");
  }

  async exportCurrentFile(): Promise<void> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice(this.t("noMarkdownNotice"));
      return;
    }

    this.openExportOptionsModal(file);
  }

  openExportOptionsModal(file: TFile): void {
    new MobilePdfExportOptionsModal(this.app, this, file).open();
  }

  warmupExportRuntime(): void {
    void loadPdfRuntime().catch((error) => {
      console.warn("Mobile PDF Exporter PDF runtime warmup failed", error);
    });
  }

  async exportFile(file: TFile, exportSettings?: MobilePdfExporterSettings, options: ExportFileOptions = {}): Promise<void> {
    const previousSettings = this.settings;
    if (exportSettings) this.settings = cloneSettings(exportSettings);
    const exportingPrompt = options.busyPrompt ?? new PdfExportBusyPrompt(file.basename, this.getResolvedLanguage());
    let rendered: RenderedPreview | null = null;

    try {
      await exportingPrompt.waitUntilPainted();
      cleanupRenderRoots();
      const markdown = await this.app.vault.cachedRead(file);
      let pdfBlob: Blob;
      if (isExcalidrawMarkdownFile(file, markdown)) {
        pdfBlob = await this.renderExcalidrawToImagePdf(file);
      } else {
        rendered = await this.renderMarkdownPreview(file, markdown);
        pdfBlob = this.settings.noteExportMode === "image"
          ? await this.renderPreviewToImagePdf(file, rendered.pageEl)
          : await this.renderPreviewToSelectablePdf(file, rendered.pageEl);
      }

      await this.ensureFolderExists(this.settings.outputFolder);
      const outputPath = await this.getAvailableOutputPath(file, this.settings.outputFolder, options.outputBaseName);
      await this.app.vault.adapter.writeBinary(outputPath, await pdfBlob.arrayBuffer());

      if (this.settings.openAfterExport) {
        await this.app.workspace.openLinkText(outputPath, file.path, true);
      }

      if (this.settings.shareAfterExport) {
        await this.sharePdfIfAvailable(pdfBlob, outputPath);
      }
      exportingPrompt.done();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Mobile PDF Exporter failed", error);
      exportingPrompt.fail(message);
    } finally {
      if (rendered) {
        rendered.renderComponent.unload();
        rendered.rootEl.remove();
      }
      exportingPrompt.closeSoon();
      this.settings = previousSettings;
    }
  }

  private async renderExcalidrawToImagePdf(file: TFile): Promise<Blob> {
    const lease = this.getExcalidrawAutomateLease();
    if (!lease) {
      throw new Error(this.t("excalidrawApiMissingError"));
    }

    const errors: string[] = [];

    try {
      const exportSettings = lease.api.getExportSettings?.(true, true, false);
      const loader = lease.api.getEmbeddedFilesLoader?.(false);
      const preferredScale = Math.min(2, Math.max(1.25, window.devicePixelRatio || 1.5));
      const scales = getExcalidrawExportScaleCandidates(preferredScale);

      // Prefer SVG so Excalidraw's own createPNG path does not show "PNG too large" notices.
      if (lease.api.createSVG) {
        try {
          lease.api.reset?.();
          const svg = await waitForPromiseOrTimeout(
            lease.api.createSVG(file.path, false, exportSettings, loader, "light", 12, true, true),
            EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS
          );
          if (svg instanceof SVGSVGElement) {
            const renderedScaleKeys = new Set<number>();
            for (const scale of scales) {
              const actualScale = getSvgSafeRasterScale(svg, scale);
              const scaleKey = Math.round(actualScale * 1000) / 1000;
              if (renderedScaleKeys.has(scaleKey)) continue;
              renderedScaleKeys.add(scaleKey);

              const pngBytes = await svgElementToPngBytes(svg, scale, EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS, this.settings.colorMode);
              if (!pngBytes || pngBytes.byteLength <= 0) continue;
              if (pngBytes.byteLength > EXCALIDRAW_PREFERRED_MAX_PNG_BYTES && actualScale > EXCALIDRAW_MIN_EXPORT_SCALE) continue;

              const pdfBlob = await this.tryBuildExcalidrawImagePdf(file, pngBytes, `SVG ${actualScale}x`);
              if (pdfBlob) return pdfBlob;
            }
          }
        } catch (error) {
          errors.push(formatErrorMessage(error));
          console.warn("Mobile PDF Exporter Excalidraw SVG fallback failed", error);
        }
      }

      if (lease.api.createPNG) {
        for (const scale of getExcalidrawPngFallbackScaleCandidates(Boolean(lease.api.createSVG))) {
          try {
            lease.api.reset?.();
            const pngBlob = await waitForPromiseOrTimeout(
              lease.api.createPNG(file.path, scale, exportSettings, loader, "light", 12),
              EXCALIDRAW_IMAGE_RENDER_TIMEOUT_MS
            );
            if (!pngBlob || pngBlob.size <= 0) {
              errors.push(`PNG ${scale}x 没有返回图片。`);
              continue;
            }

            const pdfBlob = await this.tryBuildExcalidrawImagePdf(file, await blobToUint8Array(pngBlob), `PNG ${scale}x`);
            if (pdfBlob) return pdfBlob;
          } catch (error) {
            errors.push(formatErrorMessage(error));
            console.warn(`Mobile PDF Exporter Excalidraw PNG ${scale}x failed`, error);
          }
        }
      }

      const resolvedLanguage = this.getResolvedLanguage();
      const suffix = resolvedLanguage === "zh"
        ? (errors.length > 0 ? `最后错误：${errors[errors.length - 1]}` : "未能取得可用图片。")
        : resolvedLanguage === "ko"
          ? (errors.length > 0 ? ` 마지막 오류: ${errors[errors.length - 1]}` : " 사용할 수 있는 이미지를 만들지 못했습니다.")
          : (errors.length > 0 ? ` Last error: ${errors[errors.length - 1]}` : " No usable image was produced.");
      throw new Error(`${this.t("excalidrawExportFailedError")}${suffix}`);
    } finally {
      if (lease.destroyAfterUse) lease.api.destroy?.();
    }
  }

  private async tryBuildExcalidrawImagePdf(file: TFile, imageBytes: Uint8Array, label: string): Promise<Blob | null> {
    try {
      return await this.imageBytesToSlicedExcalidrawPdf(file, imageBytes);
    } catch (error) {
      console.warn(`Mobile PDF Exporter Excalidraw PDF build failed for ${label}`, error);
      return null;
    }
  }

  private async imageBytesToSlicedExcalidrawPdf(file: TFile, imageBytes: Uint8Array): Promise<Blob> {
    const { PDFDocument: PDFDocumentRuntime } = await loadPdfRuntime();
    const sourceImage = await imageBytesToHtmlImage(imageBytes);
    const sourceWidthPx = Math.max(1, sourceImage.naturalWidth || sourceImage.width);
    const sourceHeightPx = Math.max(1, sourceImage.naturalHeight || sourceImage.height);
    const pdfDoc = await PDFDocumentRuntime.create();
    pdfDoc.setTitle(file.basename);
    pdfDoc.setSubject(EXCALIDRAW_IMAGE_PDF_SUBJECT);

    const pageSizeMm = getConfiguredPageSizeMm(this.settings);
    const pageWidthPt = mmToPt(pageSizeMm.width);
    const fixedPageHeightPt = mmToPt(pageSizeMm.height);
    const pageMarginPt = mmToPt(2);
    const usableWidthPt = Math.max(24, pageWidthPt - pageMarginPt * 2);
    const usableHeightPt = Math.max(24, fixedPageHeightPt - pageMarginPt * 2);
    const pxToPt = usableWidthPt / sourceWidthPx;
    const fullPageSourceHeightPx = Math.max(1, Math.floor(usableHeightPt / pxToPt));
    const singlePage = sourceHeightPx <= fullPageSourceHeightPx;
    let sourceY = 0;

    while (sourceY < sourceHeightPx) {
      const sourceSliceHeightPx = Math.min(fullPageSourceHeightPx, sourceHeightPx - sourceY);
      const sliceBytes = await imageSliceToPngBytes(sourceImage, sourceY, sourceSliceHeightPx, this.settings.colorMode);
      const sliceImage = await pdfDoc.embedPng(sliceBytes);
      const drawHeightPt = Math.min(usableHeightPt, sourceSliceHeightPx * pxToPt);
      const pageHeightPt = singlePage
        ? Math.max(mmToPt(20), drawHeightPt + pageMarginPt * 2)
        : fixedPageHeightPt;
      const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageWidthPt,
        height: pageHeightPt,
        color: rgb(1, 1, 1)
      });
      page.drawImage(sliceImage, {
        x: (pageWidthPt - usableWidthPt) / 2,
        y: pageHeightPt - pageMarginPt - drawHeightPt,
        width: usableWidthPt,
        height: drawHeightPt
      });

      sourceY += sourceSliceHeightPx;
      await nextAnimationFrame();
    }

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    return new Blob([getExactArrayBuffer(pdfBytes)], { type: "application/pdf" });
  }

  private getActiveMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "md") return null;
    return file;
  }

  private async renderMarkdownPreview(file: TFile, markdown: string): Promise<RenderedPreview> {
    const pageSizeMm = getConfiguredPageSizeMm(this.settings);
    const renderWidthPx = mmToPx(pageSizeMm.width);
    const paddingPx = mmToPx(this.settings.marginMm);
    const isExcalidrawFile = isExcalidrawMarkdownFile(file, markdown);
    const markdownToRender = isExcalidrawFile
      ? sanitizeExcalidrawMarkdownForPreview(markdown)
      : markdown;

    cleanupRenderRoots();
    const renderComponent = new Component();
    renderComponent.load();
    const rootEl = appendElement(activeDocument.body, "div", {
      cls: "mobile-pdf-exporter-render-root"
    });

    try {
      rootEl.setCssProps({
        "--mobile-pdf-exporter-width": `${renderWidthPx}px`,
        "--mobile-pdf-exporter-padding": `${paddingPx}px`,
        "--mobile-pdf-exporter-page-height": `${mmToPx(pageSizeMm.height)}px`,
        "--mobile-pdf-exporter-font-scale": String(this.settings.contentScalePercent / 100)
      });

      const pageEl = appendElement(rootEl, "div", {
        cls: "mobile-pdf-exporter-page markdown-reading-view"
      });

      if (this.settings.includeTitle) {
        appendElement(pageEl, "h1", {
          cls: "mobile-pdf-exporter-title",
          text: file.basename
        });
      }

      const markdownEl = appendElement(pageEl, "div", {
        cls: "markdown-preview-view markdown-rendered"
      });

      const rendered = await waitForPromiseOrTimeout(
        MarkdownRenderer.render(this.app, markdownToRender, markdownEl, file.path, renderComponent),
        PREVIEW_RENDER_TIMEOUT_MS
      );

      hideExcalidrawSourceBlocks(markdownEl);

      if (isExcalidrawFile) {
        const renderedSvg = await this.renderExcalidrawFilePreview(file, markdownEl);
        hideExcalidrawSourceBlocks(markdownEl);
        if (!renderedSvg && !hasExportableContent(markdownEl)) {
          appendElement(markdownEl, "p", {
            cls: "mobile-pdf-exporter-excalidraw-fallback",
            text: this.t("excalidrawPreviewUnavailable")
          });
        }
      }

      if (!rendered) {
        await waitForRenderedContent(markdownEl, 1000);
      }

      const previewWaitProfile = getPreviewWaitProfile(markdownEl);
      await waitForRenderedContent(markdownEl, previewWaitProfile.renderedContentMs);
      await waitForPreviewDomStable(pageEl, previewWaitProfile.initialStableMs);
      await waitForImages(pageEl, IMAGE_WAIT_TIMEOUT_MS);
      await waitForPreviewDomStable(pageEl, previewWaitProfile.finalStableMs);
      await waitForPreviewFonts(pageEl, 2500);
      await waitForPreviewDomStable(pageEl, Math.max(420, previewWaitProfile.finalStableMs));
      this.injectNoteDoodleOverlay(file, markdownEl);
      await nextAnimationFrame(FRAME_WAIT_TIMEOUT_MS);

      const rect = pageEl.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || pageEl.scrollHeight < 1 || !hasExportableContent(markdownEl)) {
        throw new Error(this.t("previewNoExportSizeError"));
      }

      return { rootEl, pageEl, renderComponent };
    } catch (error) {
      renderComponent.unload();
      rootEl.remove();
      throw error;
    }
  }

  private async renderExcalidrawFilePreview(file: TFile, markdownEl: HTMLElement): Promise<boolean> {
    const lease = this.getExcalidrawAutomateLease();
    if (!lease) return false;

    try {
      lease.api.reset?.();
      const exportSettings = lease.api.getExportSettings?.(true, true, false);
      const loader = lease.api.getEmbeddedFilesLoader?.(false);
      const svg = await waitForPromiseOrTimeout(
        lease.api.createSVG?.(file.path, false, exportSettings, loader, "light", 12, true, true) ??
          Promise.resolve(null),
        PREVIEW_RENDER_TIMEOUT_MS
      );
      if (!(svg instanceof SVGSVGElement)) return false;

      svg.classList.add("mobile-pdf-exporter-excalidraw-svg");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.setCssStyles({
        display: "block",
        width: "100%",
        maxWidth: "100%",
        height: "auto"
      });
      const viewBox = svg.viewBox.baseVal;
      if (viewBox.width > 0 && viewBox.height > 0) {
        svg.setCssStyles({ aspectRatio: `${viewBox.width} / ${viewBox.height}` });
      }

      const previewEl = appendElement(markdownEl, "div", {
        cls: "mobile-pdf-exporter-excalidraw-preview"
      });
      previewEl.appendChild(svg);
      return true;
    } catch (error) {
      console.warn("Mobile PDF Exporter Excalidraw preview failed", error);
      return false;
    } finally {
      if (lease.destroyAfterUse) lease.api.destroy?.();
    }
  }

  private getExcalidrawAutomateLease(): ExcalidrawAutomateLease | null {
    const globalApi = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateRuntime }).ExcalidrawAutomate;
    if (globalApi?.getAPI) {
      const api = globalApi.getAPI();
      if (api?.createPNG || api?.createSVG) return { api, destroyAfterUse: true };
    }

    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins;
    const excalidrawPlugin = plugins?.["obsidian-excalidraw-plugin"] as
      | { ea?: ExcalidrawAutomateRuntime }
      | undefined;
    const pluginApi = excalidrawPlugin?.ea;

    if (pluginApi?.getAPI) {
      const api = pluginApi.getAPI();
      if (api?.createPNG || api?.createSVG) return { api, destroyAfterUse: true };
    }

    if (pluginApi?.createPNG || pluginApi?.createSVG) return { api: pluginApi, destroyAfterUse: false };
    return null;
  }

  private injectNoteDoodleOverlay(file: TFile, markdownEl: HTMLElement): void {
    const overlay = getVisibleLiveDrawingOverlay(file);
    if (!overlay?.canvas && !overlay?.data?.strokes.length) return;

    const rect = markdownEl.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(markdownEl.scrollWidth || rect.width || 1));
    const height = Math.max(1, Math.ceil(markdownEl.scrollHeight || rect.height || 1));
    const maxPixelScale = Math.sqrt(PREVIEW_IMAGE_MAX_CANVAS_PIXELS / Math.max(1, width * height));
    const ratio = clampNumber(Math.min(window.devicePixelRatio || 1, maxPixelScale), 0.5, 2, 1);
    const previousPosition = getComputedStyle(markdownEl).position;
    if (previousPosition === "static") markdownEl.setCssStyles({ position: "relative" });

    markdownEl.addClass("mobile-pdf-exporter-note-doodle-host");
    const canvas = appendElement(markdownEl, "canvas", {
      cls: `mobile-pdf-exporter-note-doodle-canvas mobile-pdf-exporter-live-drawing-canvas note-doodle-canvas ${overlay.kind === "notedraw" ? "notedraw-canvas" : ""}`
    });
    canvas.width = Math.max(1, Math.ceil(width * ratio));
    canvas.height = Math.max(1, Math.ceil(height * ratio));
    canvas.setCssStyles({
      width: `${width}px`,
      height: `${height}px`,
      position: "absolute",
      left: "0",
      top: "0",
      pointerEvents: "none",
      zIndex: "60"
    });
    canvas.setAttribute("aria-hidden", "true");

    const context = canvas.getContext("2d");
    if (!context) {
      canvas.remove();
      return;
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (overlay.canvas && drawLiveDrawingCanvas(context, overlay.canvas, overlay.surface, markdownEl, width, height)) return;
    if (overlay.data?.strokes.length) drawNoteDoodleStrokes(context, overlay.data.strokes, width, height);
  }

  private async renderPreviewToSelectablePdf(file: TFile, pageEl: HTMLElement): Promise<Blob> {
    const { PDFDocument: PDFDocumentRuntime, StandardFonts, fontkitModule } = await loadPdfRuntime();
    const model = this.capturePreviewPdfModel(pageEl);

    if (
      model.textFragments.length === 0 &&
      model.imageFragments.length === 0 &&
      model.canvasFragments.length === 0 &&
      model.svgFragments.length === 0
    ) {
      throw new Error(this.t("previewNoContentError"));
    }

    const pdfDoc = await PDFDocumentRuntime.create();
    pdfDoc.setTitle(file.basename);
    pdfDoc.setSubject(PDF_SUBJECT);
    const requiresUnicodeFont = model.textFragments.some((fragment) => containsNonAsciiText(fragment.text));
    const exportFont = await this.loadExportFont(
      pdfDoc,
      fontkitModule,
      StandardFonts.Helvetica,
      requiresUnicodeFont
    );
    const { font } = exportFont;
    this.assertKoreanTextEncodable(font, model.textFragments);
    const domSnapshot = await tryPrepareDomSnapshot(model);
    const rasterScale = this.getPreviewDocumentRasterScale(
      model,
      Math.max(this.settings.imageRasterScale, SELECTABLE_PREVIEW_BACKGROUND_MIN_SCALE)
    );
    let totalPngBytes = 0;

    for (let index = 0; index < model.pageBreaks.length - 1; index += 1) {
      const pageTopPx = model.pageBreaks[index];
      const pageBottomPx = model.pageBreaks[index + 1];
      const pdfPage = pdfDoc.addPage([model.pageWidthPt, model.pageHeightPt]);
      const pngBytes = await renderPreviewPageToPngBytes(model, index, {
        colorMode: this.settings.colorMode,
        rasterScale
      }, domSnapshot);
      totalPngBytes += pngBytes.byteLength;
      if (totalPngBytes > PREVIEW_DOCUMENT_MAX_PNG_BYTES) {
        throw new Error(this.t("previewTooLargeError"));
      }
      const pageImage = await pdfDoc.embedPng(pngBytes);
      pdfPage.drawImage(pageImage, {
        x: 0,
        y: 0,
        width: model.pageWidthPt,
        height: model.pageHeightPt
      });

      drawTextLayer(pdfPage, model.textFragments, {
        font,
        pageTopPx,
        pageBottomPx,
        pageWidthPt: model.pageWidthPt,
        pageHeightPt: model.pageHeightPt,
        pxToPt: model.pxToPt,
        colorMode: this.settings.colorMode,
        opacity: SELECTABLE_TEXT_LAYER_OPACITY,
        drawUnderlines: false
      });

      drawLinkAnnotationLayer(pdfPage, model.linkFragments, {
        pageTopPx,
        pageBottomPx,
        pageWidthPt: model.pageWidthPt,
        pageHeightPt: model.pageHeightPt,
        pxToPt: model.pxToPt
      });
    }

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    return new Blob([getExactArrayBuffer(pdfBytes)], { type: "application/pdf" });
  }

  private async renderPreviewToImagePdf(file: TFile, pageEl: HTMLElement): Promise<Blob> {
    const { PDFDocument: PDFDocumentRuntime } = await loadPdfRuntime();
    const model = this.capturePreviewPdfModel(pageEl);

    if (
      model.textFragments.length === 0 &&
      model.imageFragments.length === 0 &&
      model.canvasFragments.length === 0 &&
      model.svgFragments.length === 0
    ) {
      throw new Error(this.t("previewNoContentError"));
    }

    const pdfDoc = await PDFDocumentRuntime.create();
    pdfDoc.setTitle(file.basename);
    pdfDoc.setSubject(IMAGE_PDF_SUBJECT);
    const domSnapshot = await tryPrepareDomSnapshot(model);
    const rasterScale = this.getPreviewDocumentRasterScale(model, this.settings.imageRasterScale);
    let totalPngBytes = 0;

    for (let index = 0; index < model.pageBreaks.length - 1; index += 1) {
      const pngBytes = await renderPreviewPageToPngBytes(model, index, {
        colorMode: this.settings.colorMode,
        rasterScale
      }, domSnapshot);
      totalPngBytes += pngBytes.byteLength;
      if (totalPngBytes > PREVIEW_DOCUMENT_MAX_PNG_BYTES) {
        throw new Error(this.t("previewTooLargeError"));
      }
      const pageImage = await pdfDoc.embedPng(pngBytes);
      const pdfPage = pdfDoc.addPage([model.pageWidthPt, model.pageHeightPt]);
      pdfPage.drawImage(pageImage, {
        x: 0,
        y: 0,
        width: model.pageWidthPt,
        height: model.pageHeightPt
      });

      drawLinkAnnotationLayer(pdfPage, model.linkFragments, {
        pageTopPx: model.pageBreaks[index],
        pageBottomPx: model.pageBreaks[index + 1],
        pageWidthPt: model.pageWidthPt,
        pageHeightPt: model.pageHeightPt,
        pxToPt: model.pxToPt
      });
    }

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    return new Blob([getExactArrayBuffer(pdfBytes)], { type: "application/pdf" });
  }

  private getPreviewDocumentRasterScale(model: PreviewPdfModel, requestedScale: number): number {
    try {
      return getSafeDocumentRasterScale(
        model.sourceWidthPx,
        model.pageHeightPx,
        model.pageBreaks.length - 1,
        requestedScale,
        {
          maxDimension: PREVIEW_IMAGE_MAX_CANVAS_DIMENSION,
          maxPixelsPerPage: PREVIEW_IMAGE_MAX_CANVAS_PIXELS,
          maxTotalPixels: PREVIEW_DOCUMENT_MAX_RASTER_PIXELS,
          minScale: PREVIEW_DOCUMENT_MIN_RASTER_SCALE,
          maxScale: 3
        }
      );
    } catch {
      throw new Error(this.t("previewTooLargeError"));
    }
  }

  private capturePreviewPdfModel(pageEl: HTMLElement): PreviewPdfModel {
    return withExportableElementCache(() => {
      const pageSizeMm = getConfiguredPageSizeMm(this.settings);
      const pageWidthPt = mmToPt(pageSizeMm.width);
      const pageHeightPt = mmToPt(pageSizeMm.height);
      const sourceWidthPx = Math.max(pageEl.getBoundingClientRect().width, 1);
      const pxToPt = pageWidthPt / sourceWidthPx;
      const pageHeightPx = pageHeightPt / pxToPt;
      const boxFragments = captureBoxFragments(pageEl);
      const textFragments = captureTextFragments(pageEl);
      const imageFragments = captureImageFragments(pageEl);
      const canvasFragments = captureCanvasFragments(pageEl);
      const linkFragments = captureLinkFragments(pageEl);
      const svgFragments = captureSvgFragments(pageEl);
      const decorationFragments = captureDecorationFragments(pageEl);
      const keepBlocks = captureKeepBlockFragments(
        pageEl,
        textFragments,
        imageFragments,
        canvasFragments,
        boxFragments,
        svgFragments,
        decorationFragments
      );
      const contentHeightPx = measureExportContentHeight(
        pageEl,
        textFragments,
        imageFragments,
        canvasFragments,
        boxFragments,
        svgFragments,
        decorationFragments,
        keepBlocks
      );
      const pageBreaks = computePageBreaks(contentHeightPx, pageHeightPx, keepBlocks);
      const backgroundCss = getComputedStyle(pageEl).backgroundColor || "rgb(255, 255, 255)";

      return {
        ownerDocument: pageEl.ownerDocument,
        pageEl,
        pageWidthPt,
        pageHeightPt,
        sourceWidthPx,
        pxToPt,
        pageHeightPx,
        background: parseCssColor(backgroundCss) ?? rgb(1, 1, 1),
        backgroundCss,
        boxFragments,
        textFragments,
        imageFragments,
        canvasFragments,
        linkFragments,
        svgFragments,
        decorationFragments,
        keepBlocks,
        contentHeightPx,
        pageBreaks
      };
    });
  }

  private async loadFontBytes(): Promise<ArrayBuffer> {
    if (!this.fontBytesPromise) {
      this.fontBytesPromise = this.resolveFontBytes().catch((error) => {
        this.fontBytesPromise = null;
        throw error;
      });
    }
    return this.fontBytesPromise;
  }

  private async resolveFontBytes(): Promise<ArrayBuffer> {
    let embeddedError: unknown = null;
    try {
      return await this.loadEmbeddedCompressedFontBytes();
    } catch (error) {
      embeddedError = error;
    }

    try {
      return await this.loadLocalFontBytes();
    } catch (localError) {
      console.warn("Mobile PDF Exporter Korean/CJK font unavailable.", { embeddedError, localError });
      throw new Error(this.t("fontMissingError"));
    }
  }

  private async loadEmbeddedCompressedFontBytes(): Promise<ArrayBuffer> {
    const compressedBytes = decodeBase64ToArrayBuffer(embeddedKoreanFontGzipBase64);
    const DecompressionStreamCtor = (
      globalThis as typeof globalThis & {
        DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array>;
      }
    ).DecompressionStream;
    if (DecompressionStreamCtor) {
      try {
        const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStreamCtor("gzip"));
        return await new Response(stream).arrayBuffer();
      } catch (error) {
        console.warn("Native gzip decompression failed; using the JavaScript fallback.", error);
      }
    }
    return pako.ungzip(new Uint8Array(compressedBytes)).slice().buffer;
  }

  private async loadLocalFontBytes(): Promise<ArrayBuffer> {
    let lastError: unknown = null;
    for (const relativePath of LOCAL_KOREAN_FONT_CANDIDATES) {
      try {
        return await this.app.vault.adapter.readBinary(this.getPluginAssetPath(relativePath));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("No local Korean font asset found.");
  }

  private async loadExportFont(
    pdfDoc: PDFDocument,
    fontkitModule: PdfFontkitRuntime,
    standardFont: string,
    requireUnicodeFont: boolean
  ): Promise<ExportFont> {
    try {
      pdfDoc.registerFontkit(resolvePdfFontkit(fontkitModule));
      return {
        font: await pdfDoc.embedFont(await this.loadFontBytes(), {
          subset: true,
          customName: createPdfSubsetFontName()
        }),
        supportsUnicode: true
      };
    } catch (error) {
      console.warn("Mobile PDF Exporter custom PDF font unavailable; falling back to a standard PDF font.", error);
      if (requireUnicodeFont) throw new Error(this.t("fontMissingError"));
      return {
        font: await pdfDoc.embedFont(standardFont),
        supportsUnicode: false
      };
    }
  }

  private assertKoreanTextEncodable(font: PDFFont, fragments: TextFragment[]): void {
    const checkedCodePoints = new Set<number>();
    for (const fragment of fragments) {
      for (const character of fragment.text) {
        if (!isKoreanCharacter(character)) continue;
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined || checkedCodePoints.has(codePoint)) continue;
        checkedCodePoints.add(codePoint);
        if (!canEncodePdfText(font, character)) {
          console.error("Mobile PDF Exporter Korean glyph is missing from the embedded PDF font.", {
            character,
            codePoint: codePoint.toString(16)
          });
          throw new Error(this.t("fontMissingError"));
        }
      }
    }
  }

  private getPluginAssetPath(relativePath: string): string {
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${pluginDir}/${relativePath}`);
  }

  async getOptionalAssetResourcePath(relativePath: string): Promise<string | null> {
    const assetPath = this.getPluginAssetPath(relativePath);
    if (!(await this.app.vault.adapter.exists(assetPath))) return null;
    return this.app.vault.adapter.getResourcePath(assetPath);
  }

  private async getAvailableOutputPath(file: TFile, outputFolder: string, requestedBaseName?: string): Promise<string> {
    const folder = normalizeOutputFolder(outputFolder);
    const date = new Date();
    const stamp = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
    const baseName = sanitizePdfBaseName(requestedBaseName) || sanitizeFileName(`${file.basename}-preview-${stamp}`);

    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const path = normalizePath(`${folder}/${baseName}${suffix}.pdf`);
      if (!(await this.app.vault.adapter.exists(path))) return path;
    }

    throw new Error(this.t("uniqueFileNameError"));
  }

  private async ensureFolderExists(outputFolder: string): Promise<void> {
    const folder = normalizeOutputFolder(outputFolder);
    const parts = folder.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) await this.app.vault.createFolder(current);
    }
  }

  private async sharePdfIfAvailable(pdfBlob: Blob, outputPath: string): Promise<void> {
    const share = navigator.share?.bind(navigator);
    const canShare = navigator.canShare?.bind(navigator);
    if (!share || !canShare || typeof File === "undefined") return;

    const fileName = outputPath.split("/").pop() ?? "export.pdf";
    const file = new File([pdfBlob], fileName, { type: "application/pdf" });
    const shareData: ShareData = {
      files: [file],
      title: fileName
    };

    if (!canShare(shareData)) return;

    try {
      await share(shareData);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Mobile PDF Exporter share failed", error);
      new Notice(this.t("shareFailedNotice"), 5000);
    }
  }
}

class MobilePdfExportOptionsModal extends Modal {
  private draft: MobilePdfExporterSettings;
  private saveAsDefault = false;
  private exporting = false;
  private outputBaseName: string;

  constructor(
    app: App,
    private plugin: MobilePdfExporterPlugin,
    private file: TFile
  ) {
    super(app);
    this.draft = cloneSettings(plugin.settings);
    this.outputBaseName = defaultPdfBaseName(file);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mobile-pdf-exporter-options-modal");
    this.plugin.warmupExportRuntime();

    this.addActionToolbar(contentEl);

    appendElement(contentEl, "h2", { text: this.plugin.t("optionsTitle") });
    appendElement(contentEl, "p", {
      cls: "mobile-pdf-exporter-options-subtitle",
      text: this.file.basename
    });

    this.addOutputFolderSetting(contentEl);

    new Setting(contentEl)
      .setName(this.plugin.t("exportModeName"))
      .setDesc(this.plugin.t("exportModeDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("selectable", this.plugin.t("exportModeSelectable"))
          .addOption("image", this.plugin.t("exportModeImage"))
          .setValue(this.draft.noteExportMode)
          .onChange((value) => {
            this.draft.noteExportMode = normalizeChoice(value, NOTE_PDF_EXPORT_MODES, DEFAULT_SETTINGS.noteExportMode);
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("pageSizeName"))
      .addDropdown((dropdown) => {
        for (const preset of PDF_PAGE_PRESETS) dropdown.addOption(preset, getPageLabel(preset, this.plugin.getResolvedLanguage()));
        dropdown
          .setValue(this.draft.pagePreset)
          .onChange((value) => {
            this.draft.pagePreset = normalizeChoice(value, PDF_PAGE_PRESETS, DEFAULT_SETTINGS.pagePreset);
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("orientationName"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("portrait", this.plugin.t("orientationPortrait"))
          .addOption("landscape", this.plugin.t("orientationLandscape"))
          .setValue(this.draft.pageOrientation)
          .onChange((value) => {
            this.draft.pageOrientation = normalizeChoice(value, PDF_ORIENTATIONS, DEFAULT_SETTINGS.pageOrientation);
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("colorName"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("color", this.plugin.t("colorOption"))
          .addOption("grayscale", this.plugin.t("grayscaleOption"))
          .setValue(this.draft.colorMode)
          .onChange((value) => {
            this.draft.colorMode = normalizeChoice(value, PDF_COLOR_MODES, DEFAULT_SETTINGS.colorMode);
          });
      });

    const marginSetting = new Setting(contentEl)
      .setName(this.plugin.t("marginName"))
      .setDesc(`${this.draft.marginMm} mm`);
    marginSetting.addSlider((slider) => {
      slider
        .setLimits(0, 18, 1)
        .setDynamicTooltip()
        .setValue(this.draft.marginMm)
        .onChange((value) => {
          this.draft.marginMm = value;
          marginSetting.setDesc(`${value} mm`);
        });
    });

    const scaleSetting = new Setting(contentEl)
      .setName(this.plugin.t("contentScaleName"))
      .setDesc(`${this.draft.contentScalePercent}%`);
    scaleSetting.addSlider((slider) => {
      slider
        .setLimits(80, 125, 5)
        .setDynamicTooltip()
        .setValue(this.draft.contentScalePercent)
        .onChange((value) => {
          this.draft.contentScalePercent = value;
          scaleSetting.setDesc(`${value}%`);
        });
    });

    new Setting(contentEl)
      .setName(this.plugin.t("imageQualityName"))
      .setDesc(this.plugin.t("imageQualityDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("1", this.plugin.t("imageQualityStandard"))
          .addOption("1.5", this.plugin.t("imageQualityClear"))
          .addOption("2", this.plugin.t("imageQualityHigh"))
          .addOption("3", this.plugin.t("imageQualityUltra"))
          .setValue(String(this.draft.imageRasterScale))
          .onChange((value) => {
            this.draft.imageRasterScale = clampNumber(Number.parseFloat(value), 1, 3, DEFAULT_SETTINGS.imageRasterScale);
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("includeTitleName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.includeTitle)
          .onChange((value) => {
            this.draft.includeTitle = value;
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("openAfterExportName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.openAfterExport)
          .onChange((value) => {
            this.draft.openAfterExport = value;
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("shareAfterExportName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.shareAfterExport)
          .onChange((value) => {
            this.draft.shareAfterExport = value;
          });
      });

    new Setting(contentEl)
      .setName(this.plugin.t("saveAsDefaultName"))
      .setDesc(this.plugin.t("saveAsDefaultDesc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.saveAsDefault)
          .onChange((value) => {
            this.saveAsDefault = value;
          });
      });

  }

  private addOutputFolderSetting(parent: HTMLElement): void {
    new Setting(parent)
      .setName(this.plugin.t("outputFolderName"))
      .setDesc(this.plugin.t("outputFolderDesc"))
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.outputFolder)
          .setValue(this.draft.outputFolder)
          .onChange((value) => {
            this.draft.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async exportWithDraft(): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    const exportSettings = cloneSettings(this.draft);
    const outputBaseName = sanitizePdfBaseName(this.outputBaseName) || defaultPdfBaseName(this.file);
    const exportingPrompt = new PdfExportBusyPrompt(this.file.basename, this.plugin.getResolvedLanguage());

    try {
      await exportingPrompt.waitUntilPainted();
      this.close();

      if (this.saveAsDefault) {
        this.plugin.settings = cloneSettings(exportSettings);
        await this.plugin.saveSettings();
        await this.plugin.exportFile(this.file, undefined, { outputBaseName, busyPrompt: exportingPrompt });
        return;
      }

      await this.plugin.exportFile(this.file, exportSettings, { outputBaseName, busyPrompt: exportingPrompt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      exportingPrompt.fail(message);
      exportingPrompt.closeSoon();
      throw error;
    }
  }

  private addActionToolbar(parent: HTMLElement): void {
    const toolbarEl = appendElement(parent, "div", {
      cls: "mobile-pdf-exporter-options-toolbar"
    });
    const innerEl = appendElement(toolbarEl, "div", {
      cls: "mobile-pdf-exporter-options-toolbar-inner"
    });

    const nameWrapEl = appendElement(innerEl, "label", {
      cls: "mobile-pdf-exporter-options-name"
    });
    appendElement(nameWrapEl, "span", {
      cls: "mobile-pdf-exporter-options-name-label",
      text: this.plugin.t("pdfNameLabel")
    });
    const nameInput = appendElement(nameWrapEl, "input", {
      cls: "mobile-pdf-exporter-options-name-input"
    });
    nameInput.type = "text";
    nameInput.value = this.outputBaseName;
    nameInput.placeholder = defaultPdfBaseName(this.file);
    nameInput.enterKeyHint = "done";
    nameInput.addEventListener("input", () => {
      this.outputBaseName = nameInput.value;
    });
    nameInput.addEventListener("blur", () => {
      const normalized = sanitizePdfBaseName(nameInput.value) || defaultPdfBaseName(this.file);
      this.outputBaseName = normalized;
      nameInput.value = normalized;
    });

    const exportButton = appendElement(innerEl, "button", {
      cls: "mod-cta mobile-pdf-exporter-options-button",
      text: this.plugin.t("exportPdfButton")
    });
    exportButton.type = "button";
    exportButton.addEventListener("click", () => {
      exportButton.disabled = true;
      void this.exportWithDraft().catch(() => {
        exportButton.disabled = false;
      });
    });

    const cancelButton = appendElement(innerEl, "button", {
      cls: "mobile-pdf-exporter-options-button",
      text: this.plugin.t("cancelButton")
    });
    cancelButton.type = "button";
    cancelButton.addEventListener("click", () => this.close());
  }
}

class PdfExportBusyPrompt {
  private readonly rootEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly elapsedEl: HTMLElement;
  private readonly startedAt = Date.now();
  private readonly timer: number;
  private closeTimer = 0;
  private closed = false;
  private failed = false;
  private painted = false;

  constructor(noteName: string, private readonly language: ResolvedUiLanguage) {
    this.rootEl = appendElement(activeDocument.body, "div", {
      cls: "mobile-pdf-exporter-busy"
    });
    this.titleEl = appendElement(this.rootEl, "div", {
      cls: "mobile-pdf-exporter-busy-title",
      text: translate(this.language, "busyExporting")
    });
    appendElement(this.rootEl, "div", {
      cls: "mobile-pdf-exporter-busy-file",
      text: noteName
    });
    this.elapsedEl = appendElement(this.rootEl, "div", {
      cls: "mobile-pdf-exporter-busy-elapsed",
      text: formatBusyElapsed(this.language, 0)
    });
    this.timer = window.setInterval(() => this.updateElapsed(), 1000);
  }

  async waitUntilPainted(): Promise<void> {
    if (this.closed || this.painted) return;
    this.rootEl.setCssStyles({ display: "grid" });
    this.rootEl.addClass("is-visible");
    this.rootEl.getBoundingClientRect();
    this.updateElapsed();
    await nextAnimationFrame(FRAME_WAIT_TIMEOUT_MS);
    await delay(BUSY_PROMPT_PAINT_WAIT_MS);
    this.painted = true;
  }

  done(): void {
    if (this.closed) return;
    this.rootEl.addClass("is-complete");
    this.titleEl.textContent = translate(this.language, "busyCompleteTitle");
    this.elapsedEl.textContent = translate(this.language, "busyCompleteStatus");
    window.clearInterval(this.timer);
  }

  fail(message: string): void {
    if (this.closed) return;
    this.failed = true;
    this.rootEl.addClass("is-error");
    this.titleEl.textContent = translate(this.language, "busyFailedTitle");
    this.elapsedEl.textContent = message;
    this.updateElapsed();
  }

  closeSoon(): void {
    if (this.closed || this.closeTimer) return;
    this.closeTimer = window.setTimeout(() => this.close(), this.failed ? 5200 : 1400);
  }

  private updateElapsed(): void {
    if (this.failed) return;
    const seconds = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    if (this.rootEl.classList.contains("is-complete")) {
      this.elapsedEl.textContent = translate(this.language, "busyCompleteStatus");
      return;
    }
    this.elapsedEl.textContent = formatBusyElapsed(this.language, seconds);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.timer);
    if (this.closeTimer) window.clearTimeout(this.closeTimer);
    this.rootEl.remove();
  }
}

class MobilePdfExporterSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MobilePdfExporterPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.replaceChildren();
    appendElement(containerEl, "h2", { text: "Mobile PDF Exporter KR" });
    appendElement(containerEl, "p", { text: this.plugin.t("settingsIntro") });

    appendElement(containerEl, "h3", { text: this.plugin.t("settingsGeneralHeading") });

    new Setting(containerEl)
      .setName(this.plugin.t("languageName"))
      .setDesc(this.plugin.t("languageDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("auto", this.plugin.t("languageAuto"))
          .addOption("ko", this.plugin.t("languageKorean"))
          .addOption("zh", this.plugin.t("languageChinese"))
          .addOption("en", this.plugin.t("languageEnglish"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = normalizeChoice(value, UI_LANGUAGES, DEFAULT_SETTINGS.language);
            await this.plugin.saveSettings();
            this.plugin.refreshLocalizedActions();
            this.display();
          });
      });

    appendElement(containerEl, "h3", { text: this.plugin.t("settingsNoteOptionsHeading") });

    new Setting(containerEl)
      .setName(this.plugin.t("exportModeName"))
      .setDesc(this.plugin.t("exportModeDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("selectable", this.plugin.t("exportModeSelectable"))
          .addOption("image", this.plugin.t("exportModeImage"))
          .setValue(this.plugin.settings.noteExportMode)
          .onChange(async (value) => {
            this.plugin.settings.noteExportMode = normalizeChoice(value, NOTE_PDF_EXPORT_MODES, DEFAULT_SETTINGS.noteExportMode);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("pageSizeName"))
      .setDesc(this.plugin.t("pageSizeDesc"))
      .addDropdown((dropdown) => {
        for (const preset of PDF_PAGE_PRESETS) dropdown.addOption(preset, getPageLabel(preset, this.plugin.getResolvedLanguage()));
        dropdown
          .setValue(this.plugin.settings.pagePreset)
          .onChange(async (value) => {
            this.plugin.settings.pagePreset = normalizeChoice(value, PDF_PAGE_PRESETS, DEFAULT_SETTINGS.pagePreset);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("orientationName"))
      .setDesc(this.plugin.t("orientationDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("portrait", this.plugin.t("orientationPortrait"))
          .addOption("landscape", this.plugin.t("orientationLandscape"))
          .setValue(this.plugin.settings.pageOrientation)
          .onChange(async (value) => {
            this.plugin.settings.pageOrientation = normalizeChoice(value, PDF_ORIENTATIONS, DEFAULT_SETTINGS.pageOrientation);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("colorName"))
      .setDesc(this.plugin.t("colorDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("color", this.plugin.t("colorOption"))
          .addOption("grayscale", this.plugin.t("grayscaleOption"))
          .setValue(this.plugin.settings.colorMode)
          .onChange(async (value) => {
            this.plugin.settings.colorMode = normalizeChoice(value, PDF_COLOR_MODES, DEFAULT_SETTINGS.colorMode);
            await this.plugin.saveSettings();
          });
      });

    const marginSetting = new Setting(containerEl)
      .setName(this.plugin.t("marginName"))
      .setDesc(`${this.plugin.settings.marginMm} mm`);
    marginSetting.addSlider((slider) => {
      slider
        .setLimits(0, 18, 1)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.marginMm)
        .onChange(async (value) => {
          this.plugin.settings.marginMm = value;
          marginSetting.setDesc(`${value} mm`);
          await this.plugin.saveSettings();
        });
    });

    const scaleSetting = new Setting(containerEl)
      .setName(this.plugin.t("contentScaleName"))
      .setDesc(`${this.plugin.settings.contentScalePercent}%`);
    scaleSetting.addSlider((slider) => {
      slider
        .setLimits(80, 125, 5)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.contentScalePercent)
        .onChange(async (value) => {
          this.plugin.settings.contentScalePercent = value;
          scaleSetting.setDesc(`${value}%`);
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl)
      .setName(this.plugin.t("imageQualityName"))
      .setDesc(this.plugin.t("imageQualityDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("1", this.plugin.t("imageQualityStandard"))
          .addOption("1.5", this.plugin.t("imageQualityClear"))
          .addOption("2", this.plugin.t("imageQualityHigh"))
          .addOption("3", this.plugin.t("imageQualityUltra"))
          .setValue(String(this.plugin.settings.imageRasterScale))
          .onChange(async (value) => {
            this.plugin.settings.imageRasterScale = clampNumber(Number.parseFloat(value), 1, 3, DEFAULT_SETTINGS.imageRasterScale);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("includeTitleName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeTitle)
          .onChange(async (value) => {
            this.plugin.settings.includeTitle = value;
            await this.plugin.saveSettings();
          });
      });

    appendElement(containerEl, "h3", { text: this.plugin.t("settingsSaveAndShareHeading") });

    new Setting(containerEl)
      .setName(this.plugin.t("outputFolderName"))
      .setDesc(this.plugin.t("outputFolderDesc"))
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.outputFolder)
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("openAfterExportName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.openAfterExport)
          .onChange(async (value) => {
            this.plugin.settings.openAfterExport = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.t("shareAfterExportName"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.shareAfterExport)
          .onChange(async (value) => {
            this.plugin.settings.shareAfterExport = value;
            await this.plugin.saveSettings();
          });
      });

    const codesContainer = appendElement(containerEl, "div", {
      cls: "mobile-pdf-exporter-settings-codes"
    });
    this.renderExtraCodes(codesContainer);
  }

  private renderExtraCodes(containerEl: HTMLElement): void {
    appendElement(containerEl, "div", {
      cls: "mobile-pdf-exporter-settings-codes-title",
      text: this.plugin.t("codesTitle")
    });
    appendElement(containerEl, "div", {
      cls: "mobile-pdf-exporter-settings-codes-subtitle",
      text: this.plugin.t("codesSubtitle")
    });

    const gridEl = appendElement(containerEl, "div", {
      cls: "mobile-pdf-exporter-settings-codes-grid"
    });

    for (const item of SETTINGS_EXTRA_CODE_ASSETS) {
      const codeEl = appendElement(gridEl, "div", {
        cls: "mobile-pdf-exporter-settings-code"
      });
      const linkEl = appendElement(codeEl, "a", {
        cls: "mobile-pdf-exporter-settings-code-link"
      });
      linkEl.href = item.src;
      linkEl.target = "_blank";
      linkEl.rel = "noopener";
      linkEl.setAttribute("download", item.fileName);
      linkEl.setAttribute("aria-label", item.label);
      const imageEl = appendElement(linkEl, "img", {
        cls: "mobile-pdf-exporter-settings-code-image"
      });
      imageEl.src = item.src;
      imageEl.alt = item.label;
      imageEl.loading = "lazy";
      imageEl.decoding = "async";
      appendElement(codeEl, "div", {
        cls: "mobile-pdf-exporter-settings-code-label",
        text: item.label
      });
    }
  }
}

function normalizeSettings(raw: unknown): MobilePdfExporterSettings {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Partial<MobilePdfExporterSettings>;
  return {
    language: normalizeChoice(saved.language, UI_LANGUAGES, DEFAULT_SETTINGS.language),
    outputFolder: typeof saved.outputFolder === "string" && saved.outputFolder.trim()
      ? saved.outputFolder.trim()
      : DEFAULT_SETTINGS.outputFolder,
    marginMm: clampNumber(saved.marginMm, 0, 18, DEFAULT_SETTINGS.marginMm),
    includeTitle: typeof saved.includeTitle === "boolean" ? saved.includeTitle : DEFAULT_SETTINGS.includeTitle,
    shareAfterExport: typeof saved.shareAfterExport === "boolean"
      ? saved.shareAfterExport
      : DEFAULT_SETTINGS.shareAfterExport,
    openAfterExport: typeof saved.openAfterExport === "boolean"
      ? saved.openAfterExport
      : DEFAULT_SETTINGS.openAfterExport,
    noteExportMode: normalizeChoice(saved.noteExportMode, NOTE_PDF_EXPORT_MODES, DEFAULT_SETTINGS.noteExportMode),
    pagePreset: normalizeChoice(saved.pagePreset, PDF_PAGE_PRESETS, DEFAULT_SETTINGS.pagePreset),
    pageOrientation: normalizeChoice(saved.pageOrientation, PDF_ORIENTATIONS, DEFAULT_SETTINGS.pageOrientation),
    colorMode: normalizeChoice(saved.colorMode, PDF_COLOR_MODES, DEFAULT_SETTINGS.colorMode),
    contentScalePercent: clampNumber(saved.contentScalePercent, 80, 125, DEFAULT_SETTINGS.contentScalePercent),
    imageRasterScale: clampNumber(saved.imageRasterScale, 1, 3, DEFAULT_SETTINGS.imageRasterScale)
  };
}

function cloneSettings(settings: MobilePdfExporterSettings): MobilePdfExporterSettings {
  return {
    language: settings.language,
    outputFolder: settings.outputFolder,
    marginMm: settings.marginMm,
    includeTitle: settings.includeTitle,
    shareAfterExport: settings.shareAfterExport,
    openAfterExport: settings.openAfterExport,
    noteExportMode: settings.noteExportMode,
    pagePreset: settings.pagePreset,
    pageOrientation: settings.pageOrientation,
    colorMode: settings.colorMode,
    contentScalePercent: settings.contentScalePercent,
    imageRasterScale: settings.imageRasterScale
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fallback;
}

function containsNonAsciiText(text: string): boolean {
  return /[^\u0009\u000A\u000D\u0020-\u007E]/u.test(text);
}

function isKoreanCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xffa0 && codePoint <= 0xffdc)
  );
}

function createPdfSubsetFontName(): string {
  let prefix = "";
  for (let index = 0; index < 6; index += 1) {
    prefix += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  }
  return `${prefix}+NotoSansCJKkr-Regular`;
}

function resolvePdfFontkit(moduleValue: unknown): RegisteredFontkit {
  const moduleShape = moduleValue as FontkitModuleShape;
  const candidate = typeof moduleShape.create === "function" ? moduleShape : moduleShape.default;
  if (!candidate || typeof candidate.create !== "function") {
    throw new Error("PDF 字体组件初始化失败：fontkit.create 不存在。");
  }
  return candidate as RegisteredFontkit;
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function appendElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  options: { cls?: string; text?: string } = {}
): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tagName);
  if (options.cls) element.className = options.cls;
  if (options.text !== undefined) element.textContent = options.text;
  parent.appendChild(element);
  return element;
}

function normalizeOutputFolder(folder: string): string {
  return normalizePath((folder.trim() || DEFAULT_SETTINGS.outputFolder).replace(/^\/+|\/+$/g, ""));
}

function getVisibleLiveDrawingOverlay(file: TFile): NoteDoodleOverlaySource | null {
  const candidates: NoteDoodleOverlaySource[] = [];

  for (const surface of Array.from(activeDocument.querySelectorAll<HTMLElement>(".note-doodle-shell, .notedraw-shell"))) {
    if (surface.closest(".mobile-pdf-exporter-render-root")) continue;
    const kind = surface.classList.contains("notedraw-shell") ? "notedraw" : "note-doodle";
    const controller = getLiveDrawingController(surface, kind);
    if (controller?.file?.path !== file.path) continue;
    if (!isVisibleLiveDrawingSurface(surface, kind)) continue;

    try {
      controller.render?.();
    } catch (error) {
      console.warn("Mobile PDF Exporter live drawing render refresh failed", error);
    }

    const canvas = getLiveDrawingCanvas(surface, controller, kind);
    if (!canvas || !isVisibleLiveDrawingCanvas(canvas)) continue;

    const data = normalizeNoteDoodleData(
      kind === "notedraw" ? controller.drawingData : controller.doodleData,
      file
    );
    candidates.push({
      data,
      canvas,
      surface,
      kind,
      score: scoreLiveDrawingOverlay(surface, canvas, controller)
    });
  }

  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function getLiveDrawingController(surface: HTMLElement, kind: "note-doodle" | "notedraw"): LiveDrawingController | null {
  const holder = surface as unknown as {
    _noteDoodleController?: LiveDrawingController;
    _noteDrawController?: LiveDrawingController;
  };
  return kind === "notedraw"
    ? holder._noteDrawController ?? null
    : holder._noteDoodleController ?? null;
}

function getLiveDrawingCanvas(
  surface: HTMLElement,
  controller: LiveDrawingController,
  kind: "note-doodle" | "notedraw"
): HTMLCanvasElement | null {
  if (controller.canvas instanceof HTMLCanvasElement) return controller.canvas;
  return surface.querySelector<HTMLCanvasElement>(kind === "notedraw" ? ".notedraw-canvas" : ".note-doodle-canvas");
}

function isVisibleLiveDrawingSurface(surface: HTMLElement, kind: "note-doodle" | "notedraw"): boolean {
  if (!surface.isConnected) return false;
  if (kind === "notedraw" && surface.classList.contains("is-drawing-hidden")) return false;
  if (kind === "note-doodle" && surface.classList.contains("is-doodle-hidden")) return false;
  return isScreenVisibleElement(surface);
}

function isVisibleLiveDrawingCanvas(canvas: HTMLCanvasElement): boolean {
  if (canvas.width < 1 || canvas.height < 1) return false;
  return isScreenVisibleElement(canvas);
}

function scoreLiveDrawingOverlay(surface: HTMLElement, canvas: HTMLCanvasElement, controller: LiveDrawingController): number {
  const rect = canvas.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  const ownerDocument = surface.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? activeWindow;
  const viewportWidth = Math.max(1, ownerWindow.innerWidth || ownerDocument.documentElement.clientWidth || rect.width || 1);
  const viewportHeight = Math.max(1, ownerWindow.innerHeight || ownerDocument.documentElement.clientHeight || rect.height || 1);
  const visibleLeft = Math.max(0, Math.min(viewportWidth, rect.left));
  const visibleRight = Math.max(0, Math.min(viewportWidth, rect.right));
  const visibleTop = Math.max(0, Math.min(viewportHeight, rect.top));
  const visibleBottom = Math.max(0, Math.min(viewportHeight, rect.bottom));
  const visibleArea = Math.max(0, visibleRight - visibleLeft) * Math.max(0, visibleBottom - visibleTop);
  const canvasArea = Math.max(1, rect.width * rect.height);
  const surfaceArea = Math.max(1, surfaceRect.width * surfaceRect.height);
  const visibleRatio = visibleArea / canvasArea;
  const activeBonus = controller.active ? 10_000 : 0;
  const sourceBonus = controller.surfaceType === "source" ? 400 : 0;
  return activeBonus + sourceBonus + visibleRatio * 1000 + Math.min(surfaceArea, 2_000_000) / 10_000;
}

function isScreenVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;

  let current: HTMLElement | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    current = current.parentElement;
  }

  return true;
}

function normalizeNoteDoodleData(data: unknown, file: TFile): NoteDoodleData | null {
  const candidate = data && typeof data === "object" ? data as {
    version?: unknown;
    strokes?: unknown;
    updatedAt?: unknown;
  } : null;
  const rawStrokes = Array.isArray(candidate?.strokes) ? candidate.strokes : [];
  const strokes = rawStrokes
    .map(normalizeNoteDoodleStroke)
    .filter((stroke): stroke is NoteDoodleStroke => Boolean(stroke && stroke.points.length));

  if (!strokes.length) return null;

  return {
    version: Number.isFinite(Number(candidate?.version)) ? Number(candidate?.version) : 1,
    sourcePath: file.path,
    strokes,
    updatedAt: typeof candidate?.updatedAt === "string" ? candidate.updatedAt : null
  };
}

function normalizeNoteDoodleStroke(stroke: unknown): NoteDoodleStroke | null {
  const candidate = stroke && typeof stroke === "object" ? stroke as {
    brush?: unknown;
    color?: unknown;
    width?: unknown;
    opacity?: unknown;
    count?: unknown;
    points?: unknown;
  } : null;
  const points = Array.isArray(candidate?.points) ? candidate.points : [];
  const normalizedPoints = points
    .map(normalizeNoteDoodlePoint)
    .filter((point): point is NoteDoodlePoint => Boolean(point));

  if (!normalizedPoints.length) return null;

  return {
    brush: candidate?.brush === NOTE_DOODLE_WATERCOLOR ? "watercolor" : "pen",
    color: typeof candidate?.color === "string" ? candidate.color : "#e53935",
    width: clampNumber(Number(candidate?.width), 0.5, 48, 3),
    opacity: clampNumber(Number(candidate?.opacity ?? NOTE_DOODLE_DEFAULT_OPACITY), 0.08, 1, NOTE_DOODLE_DEFAULT_OPACITY),
    count: Math.round(clampNumber(Number(candidate?.count ?? 1), 1, NOTE_DOODLE_MAX_PEN_COUNT, 1)),
    points: normalizedPoints
  };
}

function normalizeNoteDoodlePoint(point: unknown): NoteDoodlePoint | null {
  const candidate = point && typeof point === "object" ? point as { x?: unknown; y?: unknown; t?: unknown } : null;
  const x = Number(candidate?.x);
  const y = Number(candidate?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: clampNumber(x, 0, 1, 0),
    y: clampNumber(y, 0, 1, 0),
    t: Number.isFinite(Number(candidate?.t)) ? Number(candidate?.t) : Date.now()
  };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim() || "export";
}

function sanitizePdfBaseName(name: unknown): string {
  if (typeof name !== "string") return "";
  return sanitizeFileName(name.replace(/\.pdf$/i, "")).slice(0, 120);
}

function defaultPdfBaseName(file: TFile): string {
  return sanitizePdfBaseName(file.basename) || "export";
}

function mmToPx(mm: number): number {
  return Math.round((mm / 25.4) * 96);
}

function mmToPt(mm: number): number {
  return (mm / 25.4) * 72;
}

function getConfiguredPageSizeMm(settings: MobilePdfExporterSettings): PdfPageSizeMm {
  const preset = PDF_PAGE_SIZES_MM[settings.pagePreset] ?? PDF_PAGE_SIZES_MM.mobile;
  if (settings.pageOrientation === "landscape") {
    return {
      width: Math.max(preset.width, preset.height),
      height: Math.min(preset.width, preset.height)
    };
  }
  return {
    width: Math.min(preset.width, preset.height),
    height: Math.max(preset.width, preset.height)
  };
}

function isExcalidrawMarkdownFile(file: TFile, markdown: string): boolean {
  const path = file.path.toLowerCase();
  return (
    path.endsWith(".excalidraw.md") ||
    /(^|\n)excalidraw-plugin:\s*/u.test(markdown) ||
    /(^|\n)# Excalidraw Data\s*$/mu.test(markdown) ||
    /(^|\n)```compressed-json\s*$/mu.test(markdown)
  );
}

function sanitizeExcalidrawMarkdownForPreview(markdown: string): string {
  let clean = markdown.replace(/^==⚠[\s\S]*?under 'Saving'\s*(?:\r?\n|$)/mu, "");

  const dataIndex = clean.search(/^# Excalidraw Data\s*$/mu);
  if (dataIndex >= 0) clean = clean.slice(0, dataIndex);

  const drawingIndex = clean.search(/^%%\s*\r?\n## Drawing\s*$/mu);
  if (drawingIndex >= 0) clean = clean.slice(0, drawingIndex);

  const compressedJsonIndex = clean.search(/^```compressed-json\s*$/mu);
  if (compressedJsonIndex >= 0) clean = clean.slice(0, compressedJsonIndex);

  const withoutFrontmatter = clean.replace(/^---\s*[\s\S]*?\r?\n---\s*/u, "").trim();
  return withoutFrontmatter;
}

function hideExcalidrawSourceBlocks(root: HTMLElement): void {
  const sourceBlocks = Array.from(root.querySelectorAll<HTMLElement>("pre, code"));
  for (const block of sourceBlocks) {
    if (isExcalidrawSourceText(block.textContent ?? "") || block.matches(".language-compressed-json")) {
      markSkipElement(block.closest<HTMLElement>("pre") ?? block);
    }
  }

  const lineBlocks = Array.from(root.querySelectorAll<HTMLElement>("p, li, blockquote, h1, h2, h3, h4, h5, h6"));
  for (const block of lineBlocks) {
    const text = normalizeLineText(block.textContent ?? "");
    if (!text) continue;

    if (/Switch to EXCALIDRAW VIEW/iu.test(text)) {
      markSkipElement(block);
      continue;
    }

    if (/^#?\s*Excalidraw Data$/iu.test(text) || /^##?\s*(Text Elements|Element Links|Embedded Files|Drawing)$/iu.test(text)) {
      markElementAndFollowingSourceSiblings(root, block);
    }
  }
}

function markSkipElement(element: HTMLElement): void {
  element.classList.add("mobile-pdf-exporter-skip");
  element.setAttribute("aria-hidden", "true");
  element.setCssStyles({ display: "none" });
}

function markElementAndFollowingSourceSiblings(root: HTMLElement, element: HTMLElement): void {
  const boundary = element.closest<HTMLElement>(".markdown-embed, .internal-embed, .markdown-preview-view") ?? root;
  let current: HTMLElement = element;
  while (current.parentElement && current.parentElement !== boundary && current.parentElement !== root) {
    current = current.parentElement;
  }

  let sibling: Element | null = current;
  while (sibling instanceof HTMLElement) {
    if (sibling.classList.contains("mobile-pdf-exporter-excalidraw-preview")) break;
    markSkipElement(sibling);
    sibling = sibling.nextElementSibling;
  }
}

function isExcalidrawSourceText(text: string): boolean {
  return (
    /```compressed-json/iu.test(text) ||
    /\bcompressed-json\b/iu.test(text) ||
    /\bN4KAkAR[A-Za-z0-9+/]{12,}/u.test(text) ||
    /# Excalidraw Data\s+## Text Elements/iu.test(text)
  );
}

function captureTextFragments(pageEl: HTMLElement): TextFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const fragments: TextFragment[] = [];
  let previousFragment: TextFragment | null = null;
  let pendingSeparator: { grapheme: TextGraphemeFragment; mergeContainer: Element } | null = null;
  const walker = pageEl.ownerDocument.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (!isExportableElement(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    const text = textNode.nodeValue ?? "";
    if (parent && /^\s+$/u.test(text)) {
      const separator = measureRenderedWhitespaceSeparator(textNode);
      pendingSeparator = separator
        ? {
            grapheme: {
              text: separator.text,
              left: separator.left - pageRect.left,
              top: separator.top - pageRect.top,
              right: separator.right - pageRect.left,
              bottom: separator.bottom - pageRect.top
            },
            mergeContainer: getTextMergeContainer(parent)
          }
        : null;
    } else if (parent) {
      const measuredFragments = measureTextNode(textNode, parent, pageRect);
      const firstFragment = measuredFragments[0];
      if (pendingSeparator && firstFragment) {
        const sameCurrentContainer = pendingSeparator.mergeContainer === firstFragment.mergeContainer;
        const bridgesFragments = previousFragment && isRenderedWhitespaceBoundaryCompatible({
          previous: previousFragment,
          separator: pendingSeparator.grapheme,
          current: firstFragment,
          fontSize: firstFragment.fontSizePx,
          sameContainer: sameCurrentContainer && previousFragment.mergeContainer === firstFragment.mergeContainer
        });
        const leadsCurrent = isRenderedLeadingWhitespaceBoundaryCompatible({
          separator: pendingSeparator.grapheme,
          adjacent: firstFragment,
          fontSize: firstFragment.fontSizePx,
          sameContainer: sameCurrentContainer
        });
        if (bridgesFragments || leadsCurrent) {
          firstFragment.graphemes.unshift(pendingSeparator.grapheme);
        } else if (previousFragment && isRenderedTrailingWhitespaceBoundaryCompatible({
          separator: pendingSeparator.grapheme,
          adjacent: previousFragment,
          fontSize: previousFragment.fontSizePx,
          sameContainer: pendingSeparator.mergeContainer === previousFragment.mergeContainer
        })) {
          previousFragment.graphemes.push(pendingSeparator.grapheme);
        }
      }
      fragments.push(...measuredFragments);
      if (measuredFragments.length) previousFragment = measuredFragments[measuredFragments.length - 1];
      pendingSeparator = null;
    }
    node = walker.nextNode();
  }

  if (pendingSeparator && previousFragment && isRenderedTrailingWhitespaceBoundaryCompatible({
    separator: pendingSeparator.grapheme,
    adjacent: previousFragment,
    fontSize: previousFragment.fontSizePx,
    sameContainer: pendingSeparator.mergeContainer === previousFragment.mergeContainer
  })) {
    previousFragment.graphemes.push(pendingSeparator.grapheme);
  }

  return mergeAdjacentFragments(fragments);
}

function captureImageFragments(pageEl: HTMLElement): ImageFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  return Array.from(pageEl.querySelectorAll("img"))
    .filter((image) => isExportableElement(image) && image.naturalWidth > 0 && image.naturalHeight > 0)
    .map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        element: image,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
}

function captureCanvasFragments(pageEl: HTMLElement): CanvasFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  return Array.from(pageEl.querySelectorAll("canvas"))
    .filter((canvas) => isExportableElement(canvas) && canvas.width > 0 && canvas.height > 0)
    .map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return {
        element: canvas,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
}

function captureLinkFragments(pageEl: HTMLElement): LinkFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const fragments: LinkFragment[] = [];
  const seen = new Set<string>();
  const selectors = [
    "a[href]",
    "a[data-href]",
    ".external-link",
    ".internal-link"
  ].join(",");

  for (const element of Array.from(pageEl.querySelectorAll<HTMLElement>(selectors))) {
    if (!isExportableElement(element)) continue;
    const href = resolveLinkHref(element);
    if (!href || !isPdfJumpHref(href)) continue;

    for (const rect of Array.from(element.getClientRects())) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      const fragment = {
        href,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
      if (fragment.right <= fragment.left || fragment.bottom <= fragment.top) continue;

      const key = [
        href,
        Math.round(fragment.left),
        Math.round(fragment.top),
        Math.round(fragment.right),
        Math.round(fragment.bottom)
      ].join("|");
      if (seen.has(key)) continue;

      seen.add(key);
      fragments.push(fragment);
    }
  }

  return fragments;
}

function captureBoxFragments(pageEl: HTMLElement): BoxFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const selectors = [
    "pre",
    "blockquote",
    "table",
    ".callout",
    ".markdown-embed",
    ".internal-embed",
    ".HyperMD-codeblock",
    "hr"
  ].join(",");

  return Array.from(pageEl.querySelectorAll<HTMLElement>(selectors))
    .filter((element) => isExportableElement(element))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const background = parseCssColor(style.backgroundColor);
      const border = parseCssColor(style.borderColor);
      return {
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top,
        background,
        border
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
}

function captureSvgFragments(pageEl: HTMLElement): SvgFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  return Array.from(pageEl.querySelectorAll<SVGSVGElement>("svg"))
    .filter((svg) => isExportableElement(svg as unknown as HTMLElement))
    .map((svg) => {
      const rect = svg.getBoundingClientRect();
      return {
        element: svg,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top
      };
    })
    .filter((fragment) => fragment.right > fragment.left && fragment.bottom > fragment.top);
}

function captureDecorationFragments(pageEl: HTMLElement): DecorationFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const decorations: DecorationFragment[] = [];
  const itemsWithVisibleCheckbox = new Set<HTMLElement>();

  for (const checkbox of Array.from(pageEl.querySelectorAll<HTMLInputElement>("input[type='checkbox']"))) {
    if (!isExportableElement(checkbox)) continue;
    const rect = checkbox.getBoundingClientRect();
    const style = getComputedStyle(checkbox);
    if (rect.width <= 0 || rect.height <= 0) continue;
    const item = checkbox.closest<HTMLElement>("li");
    if (item) itemsWithVisibleCheckbox.add(item);
    const textRect = item ? firstTextRectInside(item) : null;
    const itemStyle = item ? getComputedStyle(item) : style;
    const fontSizePx = parseFloat(itemStyle.fontSize) || parseFloat(style.fontSize) || 16;
    const size = Math.max(8, Math.min(rect.width, rect.height, fontSizePx * 0.88));
    const centerY = textRect
      ? textRect.top - pageRect.top + textRect.height * 0.48
      : rect.top - pageRect.top + rect.height / 2;
    const left = rect.left - pageRect.left + Math.max(0, (rect.width - size) / 2);
    const top = centerY - size / 2 - fontSizePx * TASK_CHECKBOX_VERTICAL_SHIFT_EM;

    decorations.push({
      kind: "checkbox",
      left,
      top,
      right: left + size,
      bottom: top + size,
      color: parseCssColor(style.accentColor) ?? parseCssColor(style.color) ?? rgb(0.12, 0.12, 0.12),
      border: parseCssColor(style.borderColor) ?? parseCssColor(style.color) ?? rgb(0.35, 0.35, 0.35),
      checked: checkbox.checked,
      text: getTaskStatusText(checkbox),
      fontSizePx
    });
  }

  for (const item of Array.from(pageEl.querySelectorAll<HTMLElement>("li.task-list-item, li[data-task]"))) {
    if (!isExportableElement(item) || itemsWithVisibleCheckbox.has(item)) continue;
    const firstRect = firstTextRectInside(item);
    if (!firstRect) continue;

    const style = getComputedStyle(item);
    const fontSizePx = parseFloat(style.fontSize) || 16;
    const size = Math.max(9, Math.min(16, fontSizePx * 0.88));
    const textLeft = firstRect.left - pageRect.left;
    const top = firstRect.top - pageRect.top + firstRect.height * 0.48 - size / 2 - fontSizePx * TASK_CHECKBOX_VERTICAL_SHIFT_EM;
    const left = Math.max(0, textLeft - fontSizePx * 1.55);
    const checkbox = item.querySelector<HTMLInputElement>("input[type='checkbox']");
    const status = getTaskStatusFromElement(checkbox ?? item);
    const color = parseCssColor(style.accentColor) ??
      parseCssColor(style.getPropertyValue("--checkbox-color")) ??
      parseCssColor(style.color) ??
      rgb(0.12, 0.12, 0.12);
    const border = parseCssColor(style.getPropertyValue("--checkbox-border-color")) ??
      parseCssColor(style.borderColor) ??
      parseCssColor(style.color) ??
      rgb(0.35, 0.35, 0.35);

    decorations.push({
      kind: "checkbox",
      left,
      top,
      right: left + size,
      bottom: top + size,
      color,
      border,
      checked: isTaskChecked(item, checkbox, status),
      text: getTaskStatusTextFromStatus(status, item),
      fontSizePx
    });
  }

  for (const item of Array.from(pageEl.querySelectorAll<HTMLLIElement>("li"))) {
    if (!isExportableElement(item)) continue;
    if (item.querySelector("input[type='checkbox']")) continue;

    const firstRect = firstTextRectInside(item);
    if (!firstRect) continue;

    const style = getComputedStyle(item);
    const fontSizePx = parseFloat(style.fontSize) || 16;
    const color = parseCssColor(style.color) ?? rgb(0.12, 0.12, 0.12);
    const textLeft = firstRect.left - pageRect.left;
    const centerY = firstRect.top - pageRect.top + firstRect.height * 0.52;
    const parent = item.parentElement;
    const isOrdered = parent?.tagName.toLowerCase() === "ol";

    if (isOrdered) {
      const text = getOrderedListMarkerText(item);
      const markerWidth = Math.max(fontSizePx * 1.2, text.length * fontSizePx * 0.65);
      const right = Math.max(0, textLeft - fontSizePx * 0.35);
      decorations.push({
        kind: "marker",
        left: Math.max(0, right - markerWidth),
        top: centerY - fontSizePx * 0.72,
        right,
        bottom: centerY + fontSizePx * 0.32,
        color,
        border: null,
        text,
        fontSizePx
      });
    } else {
      const markerText = getUnorderedListMarkerText(item);
      if (markerText) {
        const markerWidth = Math.max(fontSizePx * 0.9, markerText.length * fontSizePx * 0.65);
        const right = Math.max(0, textLeft - fontSizePx * 0.35);
        decorations.push({
          kind: "marker",
          left: Math.max(0, right - markerWidth),
          top: centerY - fontSizePx * 0.72,
          right,
          bottom: centerY + fontSizePx * 0.32,
          color,
          border: null,
          text: markerText,
          fontSizePx
        });
        continue;
      }

      const size = Math.max(3, fontSizePx * 0.36);
      const centerX = Math.max(size, textLeft - fontSizePx * 0.72);
      decorations.push({
        kind: "bullet",
        left: centerX - size / 2,
        top: centerY - size / 2,
        right: centerX + size / 2,
        bottom: centerY + size / 2,
        color,
        border: null,
        fontSizePx
      });
    }
  }

  decorations.push(...capturePseudoTextDecorations(pageEl, pageRect));

  return decorations;
}

function captureKeepBlockFragments(
  pageEl: HTMLElement,
  textFragments: TextFragment[],
  imageFragments: ImageFragment[],
  canvasFragments: CanvasFragment[],
  boxFragments: BoxFragment[],
  svgFragments: SvgFragment[],
  decorationFragments: DecorationFragment[]
): KeepBlockFragment[] {
  const pageRect = pageEl.getBoundingClientRect();
  const selectors = [
    "img",
    "picture",
    "figure",
    ".image-embed",
    "pre",
    "blockquote",
    "table",
    ".callout",
    ".markdown-embed",
    ".internal-embed",
    "li",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6"
  ].join(",");

  const blocks = Array.from(pageEl.querySelectorAll<HTMLElement>(selectors))
    .filter((element) => isExportableElement(element))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        right: rect.right - pageRect.left,
        bottom: rect.bottom - pageRect.top,
        priority: getKeepBlockPriority(element)
      };
    })
    .filter((block) => block.right > block.left && block.bottom > block.top);

  for (const image of imageFragments) blocks.push({ ...image, priority: 6 });
  for (const canvas of canvasFragments) {
    if (!canvas.element.classList.contains("mobile-pdf-exporter-note-doodle-canvas")) {
      blocks.push({ ...canvas, priority: 4 });
    }
  }
  for (const box of boxFragments) blocks.push({ ...box, priority: 3 });
  for (const svg of svgFragments) blocks.push({ ...svg, priority: isLargeOrExcalidrawSvg(svg.element) ? 6 : 3 });
  for (const decoration of decorationFragments) blocks.push({ ...decoration, priority: 2 });
  for (const text of textFragments) blocks.push({ ...text, priority: 1 });

  return blocks;
}

function firstTextRectInside(element: HTMLElement): DOMRect | null {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isExportableElement(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const range = element.ownerDocument.createRange();
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const text = textNode.nodeValue ?? "";
    const start = text.search(/\S/u);
    if (start >= 0) {
      range.setStart(textNode, start);
      range.setEnd(textNode, Math.min(start + 1, text.length));
      const rect = firstUsefulRect(range);
      if (rect) {
        range.detach();
        return rect;
      }
    }
    node = walker.nextNode();
  }

  range.detach();
  return null;
}

function getOrderedListMarkerText(item: HTMLLIElement): string {
  const parent = item.parentElement as HTMLOListElement | null;
  const value = item.value > 0 ? item.value : null;
  const start = parent?.start && parent.start > 0 ? parent.start : 1;
  const siblings = parent
    ? Array.from(parent.children).filter((child): child is HTMLLIElement => child.tagName.toLowerCase() === "li")
    : [item];
  const index = Math.max(0, siblings.indexOf(item));
  const number = value ?? start + index;
  const listStyle = parent ? getComputedStyle(parent).listStyleType : "decimal";
  return `${formatListCounter(number, listStyle)}.`;
}

function getUnorderedListMarkerText(item: HTMLLIElement): string | null {
  const parent = item.parentElement;
  const listStyle = parent ? getComputedStyle(parent).listStyleType : "";
  if (listStyle === "circle") return "o";
  if (listStyle === "square") return "▪";
  if (listStyle && listStyle !== "disc") return null;

  const depth = getListDepth(item);
  if (depth % 3 === 1) return "o";
  if (depth % 3 === 2) return "▪";
  return null;
}

function getListDepth(item: HTMLLIElement): number {
  let depth = 0;
  let current: Element | null = item.parentElement;
  while (current) {
    if (current.tagName.toLowerCase() === "ul" || current.tagName.toLowerCase() === "ol") depth += 1;
    current = current.parentElement;
  }
  return Math.max(0, depth - 1);
}

function formatListCounter(value: number, listStyle: string): string {
  if (listStyle === "lower-alpha" || listStyle === "lower-latin") return toAlphaCounter(value).toLowerCase();
  if (listStyle === "upper-alpha" || listStyle === "upper-latin") return toAlphaCounter(value).toUpperCase();
  if (listStyle === "lower-roman") return toRomanCounter(value).toLowerCase();
  if (listStyle === "upper-roman") return toRomanCounter(value).toUpperCase();
  return String(value);
}

function toAlphaCounter(value: number): string {
  let number = Math.max(1, Math.floor(value));
  let result = "";
  while (number > 0) {
    number -= 1;
    result = String.fromCharCode(65 + (number % 26)) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

function toRomanCounter(value: number): string {
  let number = Math.max(1, Math.min(3999, Math.floor(value)));
  const parts: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
  ];
  let result = "";
  for (const [amount, marker] of parts) {
    while (number >= amount) {
      result += marker;
      number -= amount;
    }
  }
  return result;
}

function getTaskStatusText(checkbox: HTMLInputElement): string | undefined {
  const item = checkbox.closest<HTMLElement>("li");
  const status = getTaskStatusFromElement(checkbox);
  return getTaskStatusTextFromStatus(status, item);
}

function getTaskStatusFromElement(element: HTMLElement | null): string {
  const item = element?.closest<HTMLElement>("li") ?? null;
  return (
    element?.getAttribute("data-task") ??
    element?.getAttribute("data-task-state") ??
    element?.getAttribute("data-task-status") ??
    item?.getAttribute("data-task") ??
    item?.getAttribute("data-task-state") ??
    item?.getAttribute("data-task-status") ??
    ""
  );
}

function getTaskStatusTextFromStatus(status: string, item: HTMLElement | null): string | undefined {
  const clean = status.trim();
  if (!clean || clean === " " || clean.toLowerCase() === "x") return undefined;
  if (clean.length <= 2) return clean;

  if (item?.classList.contains("is-cancelled") || item?.classList.contains("task-list-item-cancelled")) return "-";
  if (item?.classList.contains("is-important") || item?.classList.contains("task-list-item-important")) return "!";
  if (item?.classList.contains("is-in-progress") || item?.classList.contains("task-list-item-in-progress")) return "/";
  return undefined;
}

function isTaskChecked(item: HTMLElement, checkbox: HTMLInputElement | null, status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return Boolean(
    checkbox?.checked ||
    normalized === "x" ||
    item.classList.contains("is-checked") ||
    item.classList.contains("is-done") ||
    item.classList.contains("task-list-item-checked")
  );
}

function capturePseudoTextDecorations(pageEl: HTMLElement, pageRect: DOMRect): DecorationFragment[] {
  const selectors = [
    ".callout-title",
    ".callout-icon",
    ".list-bullet",
    ".task-list-item",
    ".metadata-property-icon",
    ".nav-file-tag",
    ".tag"
  ].join(",");
  const decorations: DecorationFragment[] = [];

  for (const element of Array.from(pageEl.querySelectorAll<HTMLElement>(selectors))) {
    if (!isExportableElement(element)) continue;
    for (const pseudo of ["::before", "::after"] as const) {
      const style = getComputedStyle(element, pseudo);
      const text = parsePseudoContent(style.content);
      if (!text) continue;

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const fontSizePx = parseFloat(style.fontSize) || parseFloat(getComputedStyle(element).fontSize) || 16;
      const color = parseCssColor(style.color) ?? parseCssColor(getComputedStyle(element).color) ?? rgb(0.12, 0.12, 0.12);
      const width = Math.max(fontSizePx * 0.9, text.length * fontSizePx * 0.62);
      const leftOffset = pseudo === "::before" ? 0 : Math.max(0, rect.width - width);
      const topOffset = Math.max(0, (rect.height - fontSizePx) * 0.5);

      decorations.push({
        kind: "text",
        left: rect.left - pageRect.left + leftOffset,
        top: rect.top - pageRect.top + topOffset,
        right: rect.left - pageRect.left + leftOffset + width,
        bottom: rect.top - pageRect.top + topOffset + fontSizePx * 1.15,
        color,
        border: null,
        text,
        fontSizePx
      });
    }
  }

  return decorations;
}

function parsePseudoContent(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed === "none" || trimmed === "normal") return null;
  const strings = Array.from(trimmed.matchAll(/"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'/gu));
  const text = strings.length > 0
    ? strings.map((match) => match[1] ?? match[2] ?? "").join("")
    : trimmed;
  const clean = text
    .replace(/\\([0-9a-f]{1,6})\s?/giu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/\\([\\'"])/gu, "$1")
    .trim();
  if (!clean || clean.length > 8) return null;
  return clean;
}

function getKeepBlockPriority(element: HTMLElement): number {
  const tag = element.tagName.toLowerCase();
  if (tag === "svg" && isLargeOrExcalidrawSvg(element as unknown as SVGSVGElement)) return 6;
  if (tag === "img" || tag === "picture" || tag === "figure" || element.matches(".image-embed")) return 6;
  if (tag === "pre" || tag === "table") return 4;
  if (tag === "blockquote" || element.matches(".callout, .markdown-embed, .internal-embed")) return 4;
  if (tag === "li") return 3;
  if (/^h[1-6]$/u.test(tag)) return 3;
  return 2;
}

function withExportableElementCache<T>(callback: () => T): T {
  const previousCache = exportableElementCache;
  exportableElementCache = new WeakMap();
  try {
    return callback();
  } finally {
    exportableElementCache = previousCache;
  }
}

function isExportableElement(element: Element): boolean {
  const cached = exportableElementCache?.get(element);
  if (cached !== undefined) return cached;

  if (
    element.closest(
      ".mobile-pdf-exporter-skip, .collapse-indicator, .heading-collapse-indicator, .markdown-embed-link, .copy-code-button, style, script"
    )
  ) {
    exportableElementCache?.set(element, false);
    return false;
  }

  if (element.matches("pre.language-compressed-json, code.language-compressed-json")) {
    exportableElementCache?.set(element, false);
    return false;
  }
  if (isExcalidrawSourceText(element.textContent ?? "")) {
    exportableElementCache?.set(element, false);
    return false;
  }

  let current: Element | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      exportableElementCache?.set(element, false);
      return false;
    }
    current = current.parentElement;
  }

  exportableElementCache?.set(element, true);
  return true;
}

function measureTextNode(textNode: Text, parent: HTMLElement, pageRect: DOMRect): TextFragment[] {
  const style = getComputedStyle(parent);
  const fontSizePx = parseFloat(style.fontSize) || 16;
  const linkElement = parent.closest("a, .internal-link, .external-link");
  const href = resolveLinkHref(linkElement);
  const color = parseCssColor(style.color) ??
    (linkElement ? rgb(0.08, 0.36, 0.72) : rgb(0.08, 0.08, 0.08));
  const underline = Boolean(
    linkElement ||
    style.textDecorationLine.includes("underline") ||
    style.textDecoration.includes("underline")
  );
  const text = textNode.nodeValue ?? "";
  const range = textNode.ownerDocument.createRange();
  const fragments: TextFragment[] = [];
  let current: TextLineDraft | null = null;
  const mergeContainer = getTextMergeContainer(parent);

  const pushCurrent = (): void => {
    if (!current) return;
    const cleanText = normalizeLineText(current.text);
    if (cleanText) {
      fragments.push({
        text: cleanText,
        graphemes: current.graphemes,
        left: current.left,
        top: current.top,
        right: current.right,
        bottom: current.bottom,
        fontSizePx: current.fontSizePx,
        fontFamily: current.fontFamily,
        fontWeight: current.fontWeight,
        fontStyle: current.fontStyle,
        color: current.color,
        underline: current.underline,
        href: current.href,
        mergeContainer: current.mergeContainer
      });
    }
    current = null;
  };

  for (const segment of segmentTextGraphemes(text)) {
    const char = segment.text;
    const start = segment.start;
    const offset = segment.end;

    if (/^[\r\n]+$/u.test(char)) {
      pushCurrent();
      continue;
    }

    range.setStart(textNode, start);
    range.setEnd(textNode, offset);
    const rect = firstUsefulRect(range);

    if (!rect) continue;

    const left = rect.left - pageRect.left;
    const top = rect.top - pageRect.top;
    const right = rect.right - pageRect.left;
    const bottom = rect.bottom - pageRect.top;
    const sameLine =
      current &&
      Math.abs(top - current.top) <= Math.max(2.5, fontSizePx * 0.35) &&
      left >= current.right - fontSizePx * 0.75;

    if (!sameLine) pushCurrent();

    if (!current) {
      current = {
        text: "",
        graphemes: [],
        left,
        top,
        right,
        bottom,
        fontSizePx,
        fontFamily: style.fontFamily || "",
        fontWeight: style.fontWeight || "400",
        fontStyle: style.fontStyle || "normal",
        color,
        underline,
        href,
        mergeContainer
      };
    }

    const normalizedChar = /\s/u.test(char) ? " " : char;
    current.text += normalizedChar;
    current.graphemes.push({ text: normalizedChar, left, top, right, bottom });
    current.left = Math.min(current.left, left);
    current.top = Math.min(current.top, top);
    current.right = Math.max(current.right, right);
    current.bottom = Math.max(current.bottom, bottom);
  }

  pushCurrent();
  range.detach();
  return fragments;
}

function getTextMergeContainer(parent: Element): Element {
  return parent.closest(
    "td, th, p, li, dt, dd, pre, blockquote, figcaption, h1, h2, h3, h4, h5, h6, .callout-title, .callout-content, .markdown-embed, .internal-embed"
  ) ?? parent;
}

function firstUsefulRect(range: Range): DOMRect | null {
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 0.1 && rect.height > 0.1) return rect;
  }
  return null;
}

function normalizeLineText(text: string): string {
  return text.replace(/[ \t\u00A0]+/gu, " ").trim();
}

function compactSeparatorSpacing(text: string): string {
  const clean = normalizeLineText(text);
  if (!clean || isPdfJumpHref(clean)) return clean;

  const hasCjk = /[\u3400-\u9FFF\uF900-\uFAFF]/u.test(clean);
  const separatorCount = (clean.match(/[·•・|｜/、，,;；:：<>#()[\]（）【】]/gu) ?? []).length;
  if (!hasCjk && separatorCount < 2) return clean;

  return clean
    .replace(/\s*([·•・|｜/、，,;；:：<>#()[\]（）【】])\s*/gu, "$1")
    .replace(/([A-Za-z0-9])([:：])(?=[A-Za-z0-9])/gu, "$1$2 ")
    .replace(/[ \t\u00A0]{2,}/gu, " ")
    .trim();
}

function mergeAdjacentFragments(fragments: TextFragment[]): TextFragment[] {
  const sorted = [...fragments].sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));
  const merged: TextFragment[] = [];

  for (const fragment of sorted) {
    const previous = merged[merged.length - 1];
    const sameLine =
      previous &&
      isTextMergeGeometryCompatible({
        previousTop: previous.top,
        previousRight: previous.right,
        previousFontSize: previous.fontSizePx,
        currentTop: fragment.top,
        currentLeft: fragment.left,
        currentFontSize: fragment.fontSizePx,
        sameContainer: previous.mergeContainer === fragment.mergeContainer
      }) &&
      previous.underline === fragment.underline &&
      previous.href === fragment.href &&
      previous.fontFamily === fragment.fontFamily &&
      previous.fontWeight === fragment.fontWeight &&
      previous.fontStyle === fragment.fontStyle &&
      colorsEqual(previous.color, fragment.color);

    if (!sameLine) {
      merged.push({ ...fragment });
      continue;
    }

    const separator = /^\s+$/u.test(fragment.graphemes[0]?.text ?? "") ? " " : "";
    previous.text = normalizeLineText(`${previous.text}${separator}${fragment.text}`);
    previous.graphemes.push(...fragment.graphemes);
    previous.right = Math.max(previous.right, fragment.right);
    previous.bottom = Math.max(previous.bottom, fragment.bottom);
  }

  return merged;
}

function colorsEqual(left: Color, right: Color): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLinkHref(linkElement: Element | null): string | null {
  if (!linkElement) return null;
  const rawValues = [
    linkElement.getAttribute("href") ??
      "",
    linkElement.getAttribute("data-href") ??
      "",
    linkElement.getAttribute("aria-label") ??
      "",
    linkElement.getAttribute("title") ??
      "",
    linkElement.textContent ??
      ""
  ];

  for (const raw of rawValues) {
    const href = normalizePdfHref(raw);
    if (href) return href;
  }

  return null;
}

function normalizePdfHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isPdfJumpHref(trimmed)) return trimmed;

  const match = trimmed.match(/\b(?:https?:\/\/|mailto:|tel:|obsidian:)[^\s"'<>）)]+/iu);
  return match ? match[0] : null;
}

function isPdfJumpHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:|obsidian:)/iu.test(href.trim());
}

function measureExportContentHeight(
  pageEl: HTMLElement,
  textFragments: TextFragment[],
  imageFragments: ImageFragment[],
  canvasFragments: CanvasFragment[],
  boxFragments: BoxFragment[],
  svgFragments: SvgFragment[],
  decorationFragments: DecorationFragment[],
  keepBlocks: KeepBlockFragment[]
): number {
  const maxTextBottom = Math.max(0, ...textFragments.map((fragment) => fragment.bottom));
  const maxImageBottom = Math.max(0, ...imageFragments.map((fragment) => fragment.bottom));
  const maxCanvasBottom = Math.max(0, ...canvasFragments.map((fragment) => fragment.bottom));
  const maxBoxBottom = Math.max(0, ...boxFragments.map((fragment) => fragment.bottom));
  const maxSvgBottom = Math.max(0, ...svgFragments.map((fragment) => fragment.bottom));
  const maxDecorationBottom = Math.max(0, ...decorationFragments.map((fragment) => fragment.bottom));
  const maxKeepBottom = Math.max(0, ...keepBlocks.map((fragment) => fragment.bottom));
  const visibleBottom = Math.max(
    maxTextBottom,
    maxImageBottom,
    maxCanvasBottom,
    maxBoxBottom,
    maxSvgBottom,
    maxDecorationBottom,
    maxKeepBottom
  );
  if (visibleBottom > 0) return Math.ceil(visibleBottom);

  const rect = pageEl.getBoundingClientRect();
  return Math.ceil(Math.max(rect.height, 1));
}

function computePageBreaks(
  contentHeightPx: number,
  pageHeightPx: number,
  keepBlocks: KeepBlockFragment[]
): number[] {
  const breaks = [0];
  let pageTop = 0;
  const sortedBlocks = [...keepBlocks].sort((a, b) => a.top - b.top || b.priority - a.priority);

  while (pageTop + pageHeightPx < contentHeightPx - 1) {
    let nextBreak = pageTop + pageHeightPx;
    const nearbyGapBreak = findNearbyGapBreak(pageTop, nextBreak, pageHeightPx, sortedBlocks);
    if (nearbyGapBreak) nextBreak = nearbyGapBreak;

    const mediaBreak = sortedBlocks
      .filter((fragment) => {
        if (fragment.priority < 6) return false;
        const height = fragment.bottom - fragment.top;
        const startsOnThisPage = startsInsidePageBreakInterval(
          fragment.top,
          pageTop,
          nextBreak,
          PAGE_BREAK_MIN_ADVANCE_PX,
          PAGE_BREAK_PADDING_PX
        );
        const crossesBreak = fragment.bottom > nextBreak - PAGE_BREAK_PADDING_PX;
        const remainingHeight = Math.max(0, nextBreak - fragment.top);
        const preferredHeight = Math.min(height, pageHeightPx * 0.92);
        return startsOnThisPage && crossesBreak && remainingHeight < preferredHeight * 0.88;
      })
      .sort((a, b) => a.top - b.top)[0];

    if (mediaBreak) {
      const candidate = mediaBreak.top - PAGE_BREAK_PADDING_PX;
      if (candidate > pageTop + pageHeightPx * 0.15) nextBreak = candidate;
    }

    const crossing = sortedBlocks
      .filter((fragment) => {
        const height = fragment.bottom - fragment.top;
        const startsOnThisPage = fragment.top > pageTop + PAGE_BREAK_MIN_ADVANCE_PX;
        const fitsOnOnePage = height < pageHeightPx * 0.96;
        const crossesBreak = fragment.top < nextBreak - 2 && fragment.bottom > nextBreak + 2;
        return startsOnThisPage && fitsOnOnePage && crossesBreak;
      })
      .sort((a, b) => b.priority - a.priority || a.top - b.top)[0];

    if (crossing) {
      const candidate = crossing.top - PAGE_BREAK_PADDING_PX;
      if (candidate > pageTop + pageHeightPx * 0.22) nextBreak = candidate;
    }

    if (nextBreak <= pageTop + PAGE_BREAK_MIN_ADVANCE_PX) nextBreak = pageTop + pageHeightPx;
    nextBreak = clampPageBreakToPhysicalPage(pageTop, nextBreak, pageHeightPx);
    breaks.push(Math.min(nextBreak, contentHeightPx));
    pageTop = nextBreak;
  }

  if (breaks[breaks.length - 1] < contentHeightPx) breaks.push(contentHeightPx);
  return breaks;
}

function findNearbyGapBreak(
  pageTop: number,
  idealBreak: number,
  pageHeightPx: number,
  keepBlocks: KeepBlockFragment[]
): number | null {
  const minBreak = pageTop + pageHeightPx * 0.58;
  const maxBreak = pageTop + pageHeightPx * 0.98;
  const candidateBlocks = keepBlocks
    .filter((block) => block.priority >= 2 && block.bottom > pageTop && block.top < idealBreak + pageHeightPx * 0.2)
    .sort((a, b) => a.top - b.top);
  let best: { y: number; score: number } | null = null;

  for (let index = 0; index < candidateBlocks.length - 1; index += 1) {
    const current = candidateBlocks[index];
    const next = candidateBlocks[index + 1];
    const gapTop = current.bottom + PAGE_BREAK_PADDING_PX;
    const gapBottom = next.top - PAGE_BREAK_PADDING_PX;
    if (gapBottom <= gapTop) continue;
    if (gapTop < minBreak || gapTop > maxBreak) continue;

    const y = Math.min(Math.max(gapTop, minBreak), maxBreak);
    const score = Math.abs(idealBreak - y) - Math.min(64, gapBottom - gapTop) * 0.4;
    if (!best || score < best.score) best = { y, score };
  }

  return best?.y ?? null;
}

function drawTextLayer(
  page: PDFPage,
  fragments: TextFragment[],
  options: {
    font: PDFFont;
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
    colorMode: PdfColorMode;
    opacity?: number;
    drawUnderlines?: boolean;
  }
): void {
  const { font, pageTopPx, pageBottomPx, pageWidthPt, pageHeightPt, pxToPt } = options;
  const opacity = options.opacity ?? 1;
  const drawUnderlines = options.drawUnderlines ?? true;

  for (const fragment of fragments) {
    if (!verticalCenterBelongsToPage(fragment, pageTopPx, pageBottomPx)) continue;

    for (const run of getEncodableFragmentRuns(font, fragment)) {
      const localTop = run.top - pageTopPx;
      const fontSize = Math.max(1, fragment.fontSizePx * pxToPt);
      const x = clampNumber(run.left * pxToPt, 0, pageWidthPt - 0.5, 0);
      const baselineY = pageHeightPt - (localTop + fragment.fontSizePx * 0.86) * pxToPt;
      const measuredWidth = Math.max(0.1, (run.right - run.left) * pxToPt);
      const maxWidth = Math.max(0.1, Math.min(pageWidthPt - x, measuredWidth));

      const drawn = drawSafeText(page, run.text, {
        x,
        y: baselineY,
        size: fontSize,
        font,
        color: outputColor(fragment.color, options.colorMode),
        maxWidth,
        opacity,
        preserveSpacing: true
      });

      const inkWidth = Math.min(maxWidth, Math.max(0.1, drawn.width));
      if (drawUnderlines && fragment.underline && inkWidth > 0.5) {
        const underlineY = baselineY - Math.max(0.55, drawn.size * 0.12);
        page.drawLine({
          start: { x, y: underlineY },
          end: { x: x + inkWidth, y: underlineY },
          thickness: Math.max(0.35, drawn.size * 0.055),
          color: outputColor(fragment.color, options.colorMode)
        });
      }
    }
  }
}

function verticalCenterBelongsToPage(
  fragment: Pick<TextFragment, "top" | "bottom">,
  pageTopPx: number,
  pageBottomPx: number
): boolean {
  return textCenterBelongsToPage(fragment.top, fragment.bottom, pageTopPx, pageBottomPx);
}

function getEncodableFragmentRuns(font: PDFFont, fragment: TextFragment): TextGraphemeFragment[] {
  if (!fragment.graphemes.length) {
    return [{
      text: getEncodablePdfText(font, fragment.text),
      left: fragment.left,
      top: fragment.top,
      right: fragment.right,
      bottom: fragment.bottom
    }].filter((run) => Boolean(run.text));
  }

  return buildEncodablePositionedRuns(
    fragment.graphemes,
    fragment.fontSizePx,
    (text) => getEncodablePdfText(font, stripProblematicPdfChars(text))
  );
}

function drawSafeText(
  page: PDFPage,
  text: string,
  options: {
    x: number;
    y: number;
    size: number;
    font: PDFFont;
    color: Color;
    maxWidth: number;
    opacity?: number;
    preserveSpacing?: boolean;
  }
): { text: string; size: number; width: number } {
  const normalized = options.preserveSpacing
    ? text.replace(/[\r\n\t\u00A0]+/gu, " ")
    : compactSeparatorSpacing(text);
  const clean = getEncodablePdfText(options.font, stripProblematicPdfChars(normalized));
  if (!clean) return { text: "", size: options.size, width: 0 };
  const width = options.font.widthOfTextAtSize(clean, options.size);
  const fitSize = fitTextSizeToWidth(options.size, width, options.maxWidth);
  const fitWidth = options.font.widthOfTextAtSize(clean, fitSize);
  const drawOptions = {
    x: options.x,
    y: options.y,
    size: fitSize,
    font: options.font,
    color: options.color,
    opacity: options.opacity
  };

  try {
    page.drawText(clean, drawOptions);
    return { text: clean, size: fitSize, width: fitWidth };
  } catch {
    const fallback = getEncodablePdfText(options.font, clean);
    if (!fallback) return { text: "", size: fitSize, width: 0 };
    try {
      const fallbackWidth = options.font.widthOfTextAtSize(fallback, options.size);
      const fallbackSize = fitTextSizeToWidth(options.size, fallbackWidth, options.maxWidth);
      page.drawText(fallback, { ...drawOptions, size: fallbackSize });
      return {
        text: fallback,
        size: fallbackSize,
        width: options.font.widthOfTextAtSize(fallback, fallbackSize)
      };
    } catch {
      // One unsupported line should not make the whole export fail.
      return { text: "", size: fitSize, width: 0 };
    }
  }
}

function drawLinkAnnotationLayer(
  page: PDFPage,
  links: LinkFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    pageWidthPt: number;
    pageHeightPt: number;
    pxToPt: number;
  }
): void {
  for (const link of links) {
    if (link.bottom <= options.pageTopPx || link.top >= options.pageBottomPx) continue;

    const localTop = link.top - options.pageTopPx;
    const localBottom = link.bottom - options.pageTopPx;
    const x = clampNumber(link.left * options.pxToPt, 0, options.pageWidthPt - 1, 0);
    const right = clampNumber(link.right * options.pxToPt, x + 1, options.pageWidthPt, x + 1);
    const yTop = options.pageHeightPt - localTop * options.pxToPt;
    const yBottom = options.pageHeightPt - localBottom * options.pxToPt;
    const y = clampNumber(yBottom - 1, 0, options.pageHeightPt - 1, 0);
    const height = Math.max(4, Math.min(options.pageHeightPt - y, yTop - yBottom + 2));
    const width = Math.max(4, right - x);

    addLinkAnnotation(page, link.href, x, y, width, height);
  }
}

function addLinkAnnotation(page: PDFPage, href: string, x: number, y: number, width: number, height: number): void {
  const target = normalizePdfHref(href);
  if (!target || width <= 0 || height <= 0) return;

  try {
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    const left = clampNumber(x, 0, pageWidth - 1, 0);
    const bottom = clampNumber(y, 0, pageHeight - 1, 0);
    const right = clampNumber(x + width, left + 1, pageWidth, left + 1);
    const top = clampNumber(y + height, bottom + 1, pageHeight, bottom + 1);
    const context = page.doc.context;
    const annotation = context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [left, bottom, right, top],
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: getPdfStringRuntime().of(target)
      }
    });
    const annotationRef = context.register(annotation);
    page.node.addAnnot(annotationRef);
  } catch (error) {
    console.warn("Mobile PDF Exporter link annotation failed", error);
  }
}

function stripProblematicPdfChars(text: string): string {
  let stripped = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x08 || codePoint === 0x0B || codePoint === 0x0C) continue;
    if ((codePoint >= 0x0E && codePoint <= 0x1F) || codePoint === 0x7F) continue;
    if (codePoint >= 0x1F000 && codePoint <= 0x1FAFF) continue;
    stripped += char;
  }
  return stripped;
}

function shouldDrawMediaOnPage(
  fragment: { top: number; bottom: number },
  pageTopPx: number,
  pageBottomPx: number
): boolean {
  if (fragment.bottom <= pageTopPx || fragment.top >= pageBottomPx) return false;
  if (fragment.top < pageTopPx - 1) return false;
  return fragment.top < pageBottomPx - PAGE_BREAK_PADDING_PX;
}

function shouldDrawSvgOnPage(fragment: SvgFragment, pageTopPx: number, pageBottomPx: number): boolean {
  if (isLargeOrExcalidrawSvg(fragment.element)) {
    return shouldDrawMediaOnPage(fragment, pageTopPx, pageBottomPx);
  }
  return fragment.bottom >= pageTopPx && fragment.top <= pageBottomPx;
}

function isLargeOrExcalidrawSvg(svg: SVGSVGElement): boolean {
  const rect = svg.getBoundingClientRect();
  const width = rect.width || svg.clientWidth || 0;
  const height = rect.height || svg.clientHeight || 0;
  return (
    width > 96 ||
    height > 96 ||
    svg.classList.contains("mobile-pdf-exporter-excalidraw-svg") ||
    Boolean(svg.closest(".mobile-pdf-exporter-excalidraw-preview, .excalidraw, .excalidraw-svg"))
  );
}

async function tryPrepareDomSnapshot(model: PreviewPdfModel): Promise<PreparedDomSnapshot | null> {
  try {
    return await prepareDomSnapshot(model.pageEl, {
      sourceWidthPx: model.sourceWidthPx,
      backgroundCss: model.backgroundCss
    });
  } catch (error) {
    console.warn("Mobile PDF Exporter native DOM snapshot preparation failed; using compatibility renderer", error);
    return null;
  }
}

async function renderPreviewPageToPngBytes(
  model: PreviewPdfModel,
  pageIndex: number,
  options: {
    colorMode: PdfColorMode;
    rasterScale: number;
  },
  domSnapshot: PreparedDomSnapshot | null = null
): Promise<Uint8Array> {
  const pageTopPx = model.pageBreaks[pageIndex];
  const pageBottomPx = model.pageBreaks[pageIndex + 1];
  const { contentHeightPx: pageSliceHeightPx } = getFixedPageSliceLayout(
    pageTopPx,
    pageBottomPx,
    model.pageHeightPx
  );
  const scale = getSafePreviewImageScale(model.sourceWidthPx, model.pageHeightPx, options.rasterScale);
  if (domSnapshot) {
    try {
      const pageSliceBytes = await domSnapshot.renderPage({
        pageTopPx,
        pageHeightPx: pageSliceHeightPx,
        scale,
        grayscale: options.colorMode === "grayscale"
      });
      return await placePageSliceOnFixedCanvas(
        model,
        pageSliceBytes,
        pageSliceHeightPx,
        scale,
        options.colorMode
      );
    } catch (error) {
      console.warn(`Mobile PDF Exporter native DOM snapshot page ${pageIndex + 1} failed; using compatibility renderer`, error);
    }
  }

  const canvas = createCanvas(model.ownerDocument);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片版 PDF 渲染失败：canvas 不可用。");

  canvas.width = Math.max(1, Math.ceil(model.sourceWidthPx * scale));
  canvas.height = Math.max(1, Math.ceil(model.pageHeightPx * scale));
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.fillStyle = colorToCss(model.background, "color");
  context.fillRect(0, 0, model.sourceWidthPx, model.pageHeightPx);

  context.save();
  context.beginPath();
  context.rect(0, 0, model.sourceWidthPx, pageSliceHeightPx);
  context.clip();
  try {
    drawCanvasBoxLayer(context, model.boxFragments, {
      pageTopPx,
      pageBottomPx,
      colorMode: "color"
    });
    await drawCanvasImageLayer(context, model.imageFragments, {
      pageTopPx,
      pageBottomPx,
      sourceWidthPx: model.sourceWidthPx,
      pageHeightPx: pageSliceHeightPx
    });
    await drawCanvasSvgLayer(context, model.svgFragments, {
      pageTopPx,
      pageBottomPx,
      sourceWidthPx: model.sourceWidthPx,
      pageHeightPx: pageSliceHeightPx,
      rasterScale: scale
    });
    drawCanvasDecorationLayer(context, model.decorationFragments, {
      pageTopPx,
      pageBottomPx,
      sourceWidthPx: model.sourceWidthPx,
      pageHeightPx: pageSliceHeightPx,
      colorMode: "color"
    });
    drawCanvasTextLayer(context, model.textFragments, {
      pageTopPx,
      pageBottomPx,
      sourceWidthPx: model.sourceWidthPx,
      colorMode: "color"
    });
    drawCanvasBitmapLayer(context, model.canvasFragments, {
      pageTopPx,
      pageBottomPx,
      sourceWidthPx: model.sourceWidthPx,
      pageHeightPx: pageSliceHeightPx
    });
  } finally {
    context.restore();
  }

  if (options.colorMode === "grayscale") {
    context.setTransform(1, 0, 0, 1, 0, 0);
    applyCanvasGrayscale(context, canvas.width, canvas.height);
  }

  return canvasToPngBytes(canvas, PREVIEW_PAGE_MAX_PNG_BYTES);
}

async function placePageSliceOnFixedCanvas(
  model: PreviewPdfModel,
  pageSliceBytes: Uint8Array,
  pageSliceHeightPx: number,
  scale: number,
  colorMode: PdfColorMode
): Promise<Uint8Array> {
  if (pageSliceHeightPx >= model.pageHeightPx - 0.001) return pageSliceBytes;
  const canvas = createCanvas(model.ownerDocument);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("DOM snapshot page padding failed: canvas is unavailable.");

  canvas.width = Math.max(1, Math.ceil(model.sourceWidthPx * scale));
  canvas.height = Math.max(1, Math.ceil(model.pageHeightPx * scale));
  context.fillStyle = colorToCss(model.background, colorMode);
  context.fillRect(0, 0, canvas.width, canvas.height);

  const pageSlice = await imageBytesToHtmlImage(pageSliceBytes);
  const expectedSliceHeight = Math.max(1, Math.ceil(pageSliceHeightPx * scale));
  if (pageSlice.naturalWidth !== canvas.width || pageSlice.naturalHeight !== expectedSliceHeight) {
    throw new Error(
      `DOM snapshot page slice dimensions are invalid ` +
      `(${pageSlice.naturalWidth} x ${pageSlice.naturalHeight}; expected ${canvas.width} x ${expectedSliceHeight}).`
    );
  }
  context.drawImage(pageSlice, 0, 0);
  return canvasToPngBytes(canvas, PREVIEW_PAGE_MAX_PNG_BYTES);
}

function getSafePreviewImageScale(widthPx: number, heightPx: number, requestedScale: number): number {
  const safeRequested = clampNumber(
    requestedScale,
    PREVIEW_DOCUMENT_MIN_RASTER_SCALE,
    3,
    DEFAULT_SETTINGS.imageRasterScale
  );
  const maxPixelScale = Math.sqrt(PREVIEW_IMAGE_MAX_CANVAS_PIXELS / Math.max(1, widthPx * heightPx));
  const maxDimensionScale = Math.min(
    PREVIEW_IMAGE_MAX_CANVAS_DIMENSION / Math.max(1, widthPx),
    PREVIEW_IMAGE_MAX_CANVAS_DIMENSION / Math.max(1, heightPx)
  );
  return Math.max(0.25, Math.min(safeRequested, maxPixelScale, maxDimensionScale));
}

function getExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function drawCanvasBoxLayer(
  context: CanvasRenderingContext2D,
  boxes: BoxFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    colorMode: PdfColorMode;
  }
): void {
  for (const box of boxes) {
    if (box.bottom < options.pageTopPx || box.top > options.pageBottomPx) continue;
    if (!box.background && !box.border) continue;

    const x = Math.max(0, box.left);
    const y = box.top - options.pageTopPx;
    const width = Math.max(1, box.right - box.left);
    const height = Math.max(1, box.bottom - box.top);

    if (box.background) {
      context.fillStyle = colorToCss(box.background, options.colorMode);
      context.fillRect(x, y, width, height);
    }
    if (box.border) {
      context.strokeStyle = colorToCss(box.border, options.colorMode);
      context.lineWidth = 1;
      context.strokeRect(x, y, width, height);
    }
  }
}

async function drawCanvasImageLayer(
  context: CanvasRenderingContext2D,
  images: ImageFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
  }
): Promise<void> {
  for (const imageFragment of images) {
    if (!shouldDrawMediaOnPage(imageFragment, options.pageTopPx, options.pageBottomPx)) continue;

    const imageBytes = await imageElementToPngBytes(imageFragment.element, "color");
    if (!imageBytes) continue;

    try {
      const image = await imageBytesToHtmlImage(imageBytes);
      const sourceX = clampNumber(imageFragment.left, 0, options.sourceWidthPx - 4, 0);
      const localTop = Math.max(0, imageFragment.top - options.pageTopPx);
      const sourceWidth = Math.max(1, imageFragment.right - imageFragment.left);
      const sourceHeight = Math.max(1, imageFragment.bottom - imageFragment.top);
      const maxWidth = Math.max(8, options.sourceWidthPx - sourceX);
      const maxHeight = Math.max(8, options.pageHeightPx - localTop - 4);
      const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
      const width = sourceWidth * scale;
      const height = sourceHeight * scale;
      const x = sourceX + Math.max(0, Math.min(sourceWidth - width, (sourceWidth - width) / 2));
      const y = localTop;
      context.drawImage(image, x, y, width, height);
    } catch (error) {
      console.warn("Mobile PDF Exporter canvas image draw failed", error);
    }
  }
}

async function drawCanvasSvgLayer(
  context: CanvasRenderingContext2D,
  svgs: SvgFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
    rasterScale: number;
  }
): Promise<void> {
  const visibleSvgs = svgs
    .filter((svgFragment) => shouldDrawSvgOnPage(svgFragment, options.pageTopPx, options.pageBottomPx))
    .filter((svgFragment) => svgFragment.right > svgFragment.left && svgFragment.bottom > svgFragment.top)
    .sort((a, b) => Number(isLargeOrExcalidrawSvg(b.element)) - Number(isLargeOrExcalidrawSvg(a.element)))
    .slice(0, MAX_SVG_FRAGMENTS_PER_PAGE);

  for (const svgFragment of visibleSvgs) {
    try {
      const imageBytes = await svgElementToPngBytes(svgFragment.element, options.rasterScale, SVG_IMAGE_LOAD_TIMEOUT_MS, "color");
      if (!imageBytes) continue;
      const image = await imageBytesToHtmlImage(imageBytes);
      const sourceX = clampNumber(svgFragment.left, 0, options.sourceWidthPx - 4, 0);
      const localTop = Math.max(0, svgFragment.top - options.pageTopPx);
      const sourceWidth = Math.max(1, svgFragment.right - svgFragment.left);
      const sourceHeight = Math.max(1, svgFragment.bottom - svgFragment.top);
      const maxWidth = Math.max(8, options.sourceWidthPx - sourceX);
      const maxHeight = Math.max(8, options.pageHeightPx - localTop - 4);
      const scale = isLargeOrExcalidrawSvg(svgFragment.element)
        ? Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
        : 1;
      const width = Math.min(sourceWidth * scale, maxWidth);
      const height = Math.min(sourceHeight * scale, maxHeight);
      const x = sourceX + Math.max(0, Math.min(sourceWidth - width, (sourceWidth - width) / 2));
      const y = localTop;
      context.drawImage(image, x, y, width, height);
    } catch (error) {
      console.warn("Mobile PDF Exporter canvas SVG draw failed", error);
    }
  }
}

function drawCanvasBitmapLayer(
  context: CanvasRenderingContext2D,
  canvases: CanvasFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
  }
): void {
  for (const canvasFragment of canvases) {
    const visibleTop = Math.max(canvasFragment.top, options.pageTopPx);
    const visibleBottom = Math.min(canvasFragment.bottom, options.pageBottomPx);
    if (visibleBottom <= visibleTop) continue;

    const cssWidth = Math.max(1, canvasFragment.right - canvasFragment.left);
    const cssHeight = Math.max(1, canvasFragment.bottom - canvasFragment.top);
    const ratioX = canvasFragment.element.width / cssWidth;
    const ratioY = canvasFragment.element.height / cssHeight;
    const cssSliceTop = visibleTop - canvasFragment.top;
    const cssSliceHeight = visibleBottom - visibleTop;
    const sourceX = 0;
    const sourceY = Math.max(0, Math.floor(cssSliceTop * ratioY));
    const sourceWidth = Math.max(1, Math.min(canvasFragment.element.width, Math.ceil(cssWidth * ratioX)));
    const sourceHeight = Math.max(1, Math.min(canvasFragment.element.height - sourceY, Math.ceil(cssSliceHeight * ratioY)));
    const x = clampNumber(canvasFragment.left, 0, options.sourceWidthPx - 4, 0);
    const y = Math.max(0, visibleTop - options.pageTopPx);
    const width = Math.max(1, Math.min(cssWidth, options.sourceWidthPx - x));
    const height = Math.max(1, Math.min(cssSliceHeight, options.pageHeightPx - y));

    try {
      context.drawImage(
        canvasFragment.element,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        x,
        y,
        width,
        height
      );
    } catch (error) {
      console.warn("Mobile PDF Exporter canvas bitmap draw failed", error);
    }
  }
}

function drawCanvasDecorationLayer(
  context: CanvasRenderingContext2D,
  decorations: DecorationFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    pageHeightPx: number;
    colorMode: PdfColorMode;
  }
): void {
  for (const decoration of decorations) {
    if (decoration.bottom < options.pageTopPx || decoration.top > options.pageBottomPx) continue;

    const x = clampNumber(decoration.left, 0, options.sourceWidthPx - 4, 0);
    const y = decoration.top - options.pageTopPx;
    const width = Math.max(1, Math.min(decoration.right - decoration.left, options.sourceWidthPx - x));
    const height = Math.max(1, Math.min(decoration.bottom - decoration.top, options.pageHeightPx - y));

    if (decoration.kind === "checkbox") {
      drawCanvasCheckbox(context, { x, y, width, height, decoration, colorMode: options.colorMode });
      continue;
    }

    if (decoration.kind === "bullet") {
      const size = Math.max(2.4, Math.min(width, height));
      context.fillStyle = colorToCss(decoration.color, options.colorMode);
      context.beginPath();
      context.arc(x + width / 2, y + height / 2, size / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }

    if ((decoration.kind === "marker" || decoration.kind === "text") && decoration.text) {
      const fontSize = Math.max(5, decoration.fontSizePx * (decoration.kind === "text" ? 0.95 : 0.88));
      drawCanvasText(context, decoration.text, {
        x,
        y: y + Math.max(0, height - fontSize) * 0.45 + fontSize * 0.86,
        size: fontSize,
        color: decoration.color,
        maxWidth: width,
        colorMode: options.colorMode
      });
    }
  }
}

function drawCanvasCheckbox(
  context: CanvasRenderingContext2D,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    decoration: DecorationFragment;
    colorMode: PdfColorMode;
  }
): void {
  const { x, y, width, height, decoration, colorMode } = options;
  const size = Math.max(5, Math.min(width, height));
  const offsetX = x + (width - size) / 2;
  const offsetY = y + (height - size) / 2;
  const border = colorToCss(decoration.border ?? decoration.color, colorMode);
  const fill = colorToCss(decoration.color, colorMode);

  context.lineWidth = Math.max(1, size * 0.08);
  context.strokeStyle = border;
  if (decoration.checked) {
    context.fillStyle = fill;
    context.fillRect(offsetX, offsetY, size, size);
  }
  context.strokeRect(offsetX, offsetY, size, size);

  if (!decoration.checked) return;

  context.strokeStyle = "#fff";
  context.lineWidth = Math.max(1, size * 0.11);
  context.beginPath();
  context.moveTo(offsetX + size * 0.22, offsetY + size * 0.48);
  context.lineTo(offsetX + size * 0.43, offsetY + size * 0.7);
  context.lineTo(offsetX + size * 0.78, offsetY + size * 0.28);
  context.stroke();
}

function drawCanvasTextLayer(
  context: CanvasRenderingContext2D,
  fragments: TextFragment[],
  options: {
    pageTopPx: number;
    pageBottomPx: number;
    sourceWidthPx: number;
    colorMode: PdfColorMode;
  }
): void {
  for (const fragment of fragments) {
    if (!verticalCenterBelongsToPage(fragment, options.pageTopPx, options.pageBottomPx)) continue;

    const fontSize = Math.max(5, fragment.fontSizePx);
    const x = clampNumber(fragment.left, 0, options.sourceWidthPx - 4, 0);
    const y = fragment.top - options.pageTopPx + fragment.fontSizePx * 0.86;
    const measuredWidth = Math.max(0.5, fragment.right - fragment.left);
    const maxWidth = Math.max(0.5, Math.min(options.sourceWidthPx - x, measuredWidth));
    context.save();
    context.beginPath();
    context.rect(
      x,
      Math.max(0, fragment.top - options.pageTopPx - 1),
      maxWidth,
      Math.max(1, fragment.bottom - fragment.top + 2)
    );
    context.clip();
    const drawn = drawCanvasText(context, fragment.text, {
      x,
      y,
      size: fontSize,
      fontFamily: fragment.fontFamily,
      fontWeight: fragment.fontWeight,
      fontStyle: fragment.fontStyle,
      color: fragment.color,
      maxWidth,
      colorMode: options.colorMode
    });

    if (fragment.underline && drawn.width > 1) {
      const underlineY = y + Math.max(0.75, drawn.size * 0.12);
      context.strokeStyle = colorToCss(fragment.color, options.colorMode);
      context.lineWidth = Math.max(0.65, drawn.size * 0.055);
      context.beginPath();
      context.moveTo(x, underlineY);
      context.lineTo(x + Math.min(maxWidth, measuredWidth + 2, drawn.width), underlineY);
      context.stroke();
    }
    context.restore();
  }
}

function drawCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  options: {
    x: number;
    y: number;
    size: number;
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
    color: Color;
    maxWidth: number;
    colorMode: PdfColorMode;
  }
): { text: string; size: number; width: number } {
  const clean = normalizeCanvasVisibleText(text);
  if (!clean) return { text: "", size: options.size, width: 0 };

  let size = options.size;
  let runs = splitCanvasTextRuns(clean);
  let width = measureCanvasTextRuns(context, runs, size, options);
  if (width > options.maxWidth) {
    size = fitTextSizeToWidth(size, width, options.maxWidth);
    runs = splitCanvasTextRuns(clean);
    width = measureCanvasTextRuns(context, runs, size, options);
  }

  context.fillStyle = colorToCss(options.color, options.colorMode);
  context.textBaseline = "alphabetic";
  drawCanvasTextRuns(context, runs, options.x, options.y, size, options);
  return { text: clean, size, width };
}

function splitCanvasTextRuns(text: string): Array<{ text: string; emoji: boolean }> {
  const runs: Array<{ text: string; emoji: boolean }> = [];
  const segments = Array.from(
    text.matchAll(/(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?|[^\uFE0F])/gu),
    (match) => match[0]
  );
  for (const segment of segments) {
    const emoji = isEmojiLikeText(segment);
    const previous = runs[runs.length - 1];
    if (previous && previous.emoji === emoji) {
      previous.text += segment;
    } else {
      runs.push({ text: segment, emoji });
    }
  }
  return runs;
}

function measureCanvasTextRuns(
  context: CanvasRenderingContext2D,
  runs: Array<{ text: string; emoji: boolean }>,
  size: number,
  fontOptions: {
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
  } = {}
): number {
  let width = 0;
  for (const run of runs) {
    if (run.emoji) {
      width += measureEmojiCanvasText(run.text, size);
      continue;
    }
    context.font = getCanvasTextFont(size, run.emoji, fontOptions);
    width += context.measureText(run.text).width;
  }
  return width;
}

function drawCanvasTextRuns(
  context: CanvasRenderingContext2D,
  runs: Array<{ text: string; emoji: boolean }>,
  x: number,
  y: number,
  size: number,
  fontOptions: {
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
  } = {}
): void {
  let cursorX = x;
  for (const run of runs) {
    if (run.emoji) {
      cursorX += drawEmojiCanvasText(context, run.text, cursorX, y, size);
      continue;
    }
    context.font = getCanvasTextFont(size, run.emoji, fontOptions);
    context.fillText(run.text, cursorX, y);
    cursorX += context.measureText(run.text).width;
  }
}

function getCanvasTextFont(
  size: number,
  emoji: boolean,
  fontOptions: {
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
  } = {}
): string {
  const textFonts = getCanvasFontFamily(fontOptions.fontFamily);
  const emojiFonts = `"Segoe UI Emoji", "Segoe UI Symbol", "Apple Color Emoji", "Noto Color Emoji"`;
  const weight = normalizeCanvasFontPart(fontOptions.fontWeight, "400");
  const style = normalizeCanvasFontPart(fontOptions.fontStyle, "normal");
  return emoji
    ? `normal 400 ${size}px ${emojiFonts}, ${textFonts}`
    : `${style} ${weight} ${size}px ${textFonts}, ${emojiFonts}`;
}

function getCanvasFontFamily(fontFamily?: string): string {
  const fallback = `"Noto Sans CJK KR", "Noto Sans KR", "Apple SD Gothic Neo", "Noto Sans SC", sans-serif`;
  const clean = (fontFamily ?? "").trim();
  if (!clean) return fallback;
  return `${clean}, ${fallback}`;
}

function normalizeCanvasFontPart(value: string | undefined, fallback: string): string {
  const clean = (value ?? "").trim();
  if (!clean) return fallback;
  return /^[\w -]+$/u.test(clean) ? clean : fallback;
}

function normalizeCanvasVisibleText(text: string): string {
  const singleLine = text.replace(/[\r\n\t\u00A0]+/gu, " ").replace(/ {2,}/gu, " ");
  if (isSeparatorOnlyText(singleLine)) return " · ";
  return singleLine.trim();
}

function isSeparatorOnlyText(text: string): boolean {
  return /^[\s\u00A0]*[·•・][\s\u00A0]*$/u.test(text);
}

function isEmojiLikeText(text: string): boolean {
  return /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text);
}

function measureEmojiCanvasText(text: string, size: number): number {
  return getEmojiSegments(text).reduce((width, segment) => width + getEmojiIconAdvance(segment, size), 0);
}

function drawEmojiCanvasText(context: CanvasRenderingContext2D, text: string, x: number, baselineY: number, size: number): number {
  let cursorX = x;
  for (const segment of getEmojiSegments(text)) {
    const advance = getEmojiIconAdvance(segment, size);
    drawEmojiIcon(context, segment, cursorX, baselineY, size);
    cursorX += advance;
  }
  return cursorX - x;
}

function getEmojiSegments(text: string): string[] {
  return Array.from(
    text.replace(/\uFE0F/gu, "").matchAll(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|./gu),
    (match) => match[0]
  ).filter((segment) => segment && segment !== "\uFE0F");
}

function getEmojiIconAdvance(segment: string, size: number): number {
  if (segment === "🔤") return size * 1.3;
  return isEmojiLikeText(segment) ? size * 1.08 : size * 0.55;
}

function drawEmojiIcon(context: CanvasRenderingContext2D, emoji: string, x: number, baselineY: number, size: number): void {
  if (!isEmojiLikeText(emoji)) {
    context.fillText(emoji, x, baselineY);
    return;
  }

  const iconSize = Math.max(7, size * 0.92);
  const top = baselineY - iconSize * 0.84;
  const left = x + Math.max(0, (size * 1.08 - iconSize) / 2);
  const centerX = left + iconSize / 2;
  const centerY = top + iconSize / 2;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1.1, iconSize * 0.12);

  switch (emoji) {
    case "📎":
      context.strokeStyle = "#6b7280";
      context.lineWidth = Math.max(1.2, iconSize * 0.13);
      context.beginPath();
      context.moveTo(left + iconSize * 0.36, top + iconSize * 0.25);
      context.lineTo(left + iconSize * 0.64, top + iconSize * 0.12);
      context.quadraticCurveTo(left + iconSize * 0.86, top + iconSize * 0.26, left + iconSize * 0.72, top + iconSize * 0.48);
      context.lineTo(left + iconSize * 0.38, top + iconSize * 0.82);
      context.quadraticCurveTo(left + iconSize * 0.18, top + iconSize * 0.66, left + iconSize * 0.34, top + iconSize * 0.45);
      context.lineTo(left + iconSize * 0.58, top + iconSize * 0.22);
      context.stroke();
      break;
    case "💬":
      context.fillStyle = "#8b5cf6";
      roundedRectPath(context, left + iconSize * 0.08, top + iconSize * 0.18, iconSize * 0.78, iconSize * 0.58, iconSize * 0.18);
      context.fill();
      context.beginPath();
      context.moveTo(left + iconSize * 0.36, top + iconSize * 0.72);
      context.lineTo(left + iconSize * 0.28, top + iconSize * 0.92);
      context.lineTo(left + iconSize * 0.52, top + iconSize * 0.75);
      context.fill();
      break;
    case "💡":
      context.fillStyle = "#facc15";
      context.beginPath();
      context.arc(centerX, top + iconSize * 0.42, iconSize * 0.28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#9ca3af";
      roundedRectPath(context, left + iconSize * 0.36, top + iconSize * 0.68, iconSize * 0.28, iconSize * 0.18, iconSize * 0.04);
      context.fill();
      break;
    case "💼":
      context.fillStyle = "#8b5a2b";
      roundedRectPath(context, left + iconSize * 0.12, top + iconSize * 0.34, iconSize * 0.76, iconSize * 0.48, iconSize * 0.08);
      context.fill();
      context.strokeStyle = "#5b3a1c";
      context.strokeRect(left + iconSize * 0.39, top + iconSize * 0.22, iconSize * 0.22, iconSize * 0.14);
      break;
    case "📋":
    case "📅":
      context.fillStyle = "#bfdbfe";
      roundedRectPath(context, left + iconSize * 0.18, top + iconSize * 0.12, iconSize * 0.64, iconSize * 0.78, iconSize * 0.08);
      context.fill();
      context.strokeStyle = "#2563eb";
      context.stroke();
      context.fillStyle = "#64748b";
      context.fillRect(left + iconSize * 0.32, top + iconSize * 0.32, iconSize * 0.36, iconSize * 0.06);
      context.fillRect(left + iconSize * 0.32, top + iconSize * 0.48, iconSize * 0.32, iconSize * 0.06);
      break;
    case "📚":
      drawBook(context, left + iconSize * 0.1, top + iconSize * 0.2, iconSize * 0.2, iconSize * 0.62, "#ef4444");
      drawBook(context, left + iconSize * 0.34, top + iconSize * 0.16, iconSize * 0.2, iconSize * 0.66, "#22c55e");
      drawBook(context, left + iconSize * 0.58, top + iconSize * 0.24, iconSize * 0.2, iconSize * 0.58, "#3b82f6");
      break;
    case "🎬":
      context.fillStyle = "#111827";
      roundedRectPath(context, left + iconSize * 0.12, top + iconSize * 0.28, iconSize * 0.76, iconSize * 0.52, iconSize * 0.07);
      context.fill();
      context.strokeStyle = "#fff";
      context.lineWidth = Math.max(0.8, iconSize * 0.08);
      context.beginPath();
      context.moveTo(left + iconSize * 0.2, top + iconSize * 0.42);
      context.lineTo(left + iconSize * 0.32, top + iconSize * 0.3);
      context.moveTo(left + iconSize * 0.45, top + iconSize * 0.42);
      context.lineTo(left + iconSize * 0.57, top + iconSize * 0.3);
      context.moveTo(left + iconSize * 0.7, top + iconSize * 0.42);
      context.lineTo(left + iconSize * 0.82, top + iconSize * 0.3);
      context.stroke();
      break;
    case "✅":
    case "☑":
      context.fillStyle = "#22c55e";
      roundedRectPath(context, left + iconSize * 0.16, top + iconSize * 0.16, iconSize * 0.68, iconSize * 0.68, iconSize * 0.12);
      context.fill();
      context.strokeStyle = "#fff";
      context.beginPath();
      context.moveTo(left + iconSize * 0.32, top + iconSize * 0.52);
      context.lineTo(left + iconSize * 0.46, top + iconSize * 0.66);
      context.lineTo(left + iconSize * 0.72, top + iconSize * 0.34);
      context.stroke();
      break;
    case "🎯":
      context.fillStyle = "#ef4444";
      context.beginPath();
      context.arc(centerX, centerY, iconSize * 0.38, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#fff";
      context.beginPath();
      context.arc(centerX, centerY, iconSize * 0.24, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#ef4444";
      context.beginPath();
      context.arc(centerX, centerY, iconSize * 0.1, 0, Math.PI * 2);
      context.fill();
      break;
    case "🔤":
      context.fillStyle = "#3b82f6";
      roundedRectPath(context, left, top + iconSize * 0.18, iconSize * 1.15, iconSize * 0.64, iconSize * 0.08);
      context.fill();
      context.fillStyle = "#fff";
      context.font = `600 ${Math.max(6, iconSize * 0.42)}px sans-serif`;
      context.fillText("abc", left + iconSize * 0.16, baselineY - iconSize * 0.16);
      break;
    case "🏠":
      context.fillStyle = "#f97316";
      context.beginPath();
      context.moveTo(centerX, top + iconSize * 0.16);
      context.lineTo(left + iconSize * 0.88, top + iconSize * 0.46);
      context.lineTo(left + iconSize * 0.76, top + iconSize * 0.46);
      context.lineTo(left + iconSize * 0.76, top + iconSize * 0.84);
      context.lineTo(left + iconSize * 0.24, top + iconSize * 0.84);
      context.lineTo(left + iconSize * 0.24, top + iconSize * 0.46);
      context.lineTo(left + iconSize * 0.12, top + iconSize * 0.46);
      context.closePath();
      context.fill();
      break;
    default:
      context.fillStyle = getGenericEmojiColor(emoji);
      context.beginPath();
      context.arc(centerX, centerY, iconSize * 0.34, 0, Math.PI * 2);
      context.fill();
      break;
  }

  context.restore();
}

function drawBook(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color: string): void {
  context.fillStyle = color;
  roundedRectPath(context, x, y, width, height, Math.max(1, width * 0.15));
  context.fill();
  context.fillStyle = "rgba(255,255,255,0.85)";
  context.fillRect(x + width * 0.16, y + height * 0.18, width * 0.12, height * 0.64);
}

function roundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function getGenericEmojiColor(emoji: string): string {
  switch (emoji) {
    case "🌈":
      return "#22c55e";
    case "🎮":
      return "#8b5cf6";
    case "🧠":
      return "#ec4899";
    case "💻":
    case "🖥":
      return "#3b82f6";
    case "🤝":
      return "#f59e0b";
    default:
      return "#64748b";
  }
}

async function imageElementToPngBytes(image: HTMLImageElement, colorMode: PdfColorMode = "color"): Promise<Uint8Array | null> {
  try {
    return await rasterizeImageToPngBytes(
      image,
      {
        maxDimension: COMPAT_IMAGE_MAX_CANVAS_DIMENSION,
        maxPixels: COMPAT_IMAGE_MAX_CANVAS_PIXELS,
        maxPngBytes: COMPAT_IMAGE_MAX_PNG_BYTES
      },
      colorMode === "grayscale" ? applyCanvasGrayscale : undefined
    );
  } catch (error) {
    console.warn("Mobile PDF Exporter image embed failed", error);
    return null;
  }
}

async function svgElementToPngBytes(
  svg: SVGSVGElement,
  preferredScale?: number,
  timeoutMs = SVG_IMAGE_LOAD_TIMEOUT_MS,
  colorMode: PdfColorMode = "color"
): Promise<Uint8Array | null> {
  try {
    const { width, height } = getSvgRasterSize(svg);
    const canvas = createCanvas(svg);
    const context = canvas.getContext("2d");
    if (!context) return null;

    const requestedScale = preferredScale ?? Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const scale = getSvgSafeRasterScale(svg, requestedScale);
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
    clone.setCssStyles({ color: getComputedStyle(svg).color });

    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url, timeoutMs);
      context.drawImage(image, 0, 0, width, height);
      if (colorMode === "grayscale") applyCanvasGrayscale(context, canvas.width, canvas.height);
      return await canvasToPngBytes(canvas, PREVIEW_PAGE_MAX_PNG_BYTES);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    console.warn("Mobile PDF Exporter SVG embed failed", error);
    return null;
  }
}

async function imageBytesToHtmlImage(imageBytes: Uint8Array): Promise<HTMLImageElement> {
  const bytes = new Uint8Array(imageBytes.byteLength);
  bytes.set(imageBytes);
  const blob = new Blob([bytes.buffer], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url, EXCALIDRAW_IMAGE_LOAD_TIMEOUT_MS);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageSliceToPngBytes(
  image: HTMLImageElement,
  sourceY: number,
  sourceSliceHeight: number,
  colorMode: PdfColorMode = "color"
): Promise<Uint8Array> {
  const sourceWidth = Math.max(1, image.naturalWidth || image.width);
  const sourceHeight = Math.max(1, image.naturalHeight || image.height);
  const cropY = Math.max(0, Math.min(Math.floor(sourceY), sourceHeight - 1));
  const cropHeight = Math.max(1, Math.min(Math.ceil(sourceSliceHeight), sourceHeight - cropY));
  const scale = Math.min(
    1,
    EXCALIDRAW_MAX_SLICE_WIDTH_PX / sourceWidth,
    EXCALIDRAW_MAX_SLICE_HEIGHT_PX / cropHeight,
    Math.sqrt(EXCALIDRAW_MAX_SLICE_PIXELS / Math.max(1, sourceWidth * cropHeight))
  );
  const targetWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.floor(cropHeight * scale));
  const canvas = createCanvas(image);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("图片切片失败：canvas 不可用。");

  canvas.width = targetWidth;
  canvas.height = targetHeight;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = scale < 1 ? "high" : "medium";
  context.drawImage(image, 0, cropY, sourceWidth, cropHeight, 0, 0, targetWidth, targetHeight);
  if (colorMode === "grayscale") applyCanvasGrayscale(context, canvas.width, canvas.height);
  return canvasToPngBytes(canvas, PREVIEW_PAGE_MAX_PNG_BYTES);
}

function drawLiveDrawingCanvas(
  context: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  sourceSurface: HTMLElement,
  targetSurface: HTMLElement,
  width: number,
  height: number
): boolean {
  if (sourceCanvas.width < 1 || sourceCanvas.height < 1) return false;

  try {
    const sourceRect = sourceCanvas.getBoundingClientRect();
    const surfaceRect = sourceSurface.getBoundingClientRect();
    const targetRect = targetSurface.getBoundingClientRect();
    const sourceCssWidth = Math.max(1, sourceRect.width || sourceCanvas.clientWidth || sourceCanvas.width);
    const sourceCssHeight = Math.max(1, sourceRect.height || sourceCanvas.clientHeight || sourceCanvas.height);
    const scaleX = sourceCanvas.width / sourceCssWidth;
    const scaleY = sourceCanvas.height / sourceCssHeight;
    const offsetLeftCss = Math.max(0, sourceRect.left - surfaceRect.left);
    const offsetTopCss = Math.max(0, sourceRect.top - surfaceRect.top);
    const copyWidthCss = Math.max(1, Math.min(sourceCssWidth, surfaceRect.width || sourceCssWidth));
    const copyHeightCss = Math.max(1, Math.min(sourceCssHeight, surfaceRect.height || sourceCssHeight));
    const cropX = Math.max(0, Math.min(Math.floor(offsetLeftCss * scaleX), sourceCanvas.width - 1));
    const cropY = Math.max(0, Math.min(Math.floor(offsetTopCss * scaleY), sourceCanvas.height - 1));
    const cropWidth = Math.max(1, Math.min(Math.ceil(copyWidthCss * scaleX), sourceCanvas.width - cropX));
    const cropHeight = Math.max(1, Math.min(Math.ceil(copyHeightCss * scaleY), sourceCanvas.height - cropY));
    const targetWidth = Math.max(1, width);
    const targetHeight = Math.max(1, height);
    const surfaceAspect = copyWidthCss / copyHeightCss;
    const targetAspect = targetRect.width > 0 && targetRect.height > 0
      ? targetRect.width / targetRect.height
      : targetWidth / targetHeight;

    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (Math.abs(surfaceAspect - targetAspect) > 0.18) {
      context.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, targetWidth, targetHeight);
    } else {
      context.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
    }
    context.restore();
    return true;
  } catch (error) {
    context.restore();
    console.warn("Mobile PDF Exporter live drawing canvas draw failed", error);
    return false;
  }
}

function drawNoteDoodleStrokes(
  context: CanvasRenderingContext2D,
  strokes: NoteDoodleStroke[],
  width: number,
  height: number
): void {
  for (const stroke of strokes) {
    if (stroke.brush === NOTE_DOODLE_WATERCOLOR) {
      drawNoteDoodleWatercolorStroke(context, stroke, width, height);
    } else {
      drawNoteDoodlePenStroke(context, stroke, width, height);
    }
  }
}

function drawNoteDoodlePenStroke(
  context: CanvasRenderingContext2D,
  stroke: NoteDoodleStroke,
  width: number,
  height: number
): void {
  if (!stroke.points.length) return;
  const offsets = getNoteDoodlePenOffsets(stroke.count, stroke.width);

  context.save();
  context.globalAlpha = stroke.opacity;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;

  for (const offset of offsets) {
    context.beginPath();
    const first = noteDoodlePointToCanvas(stroke.points[0], width, height);
    context.moveTo(first.x + offset.x, first.y + offset.y);

    for (const point of stroke.points.slice(1)) {
      const next = noteDoodlePointToCanvas(point, width, height);
      context.lineTo(next.x + offset.x, next.y + offset.y);
    }

    context.stroke();
  }

  context.restore();
}

function drawNoteDoodleWatercolorStroke(
  context: CanvasRenderingContext2D,
  stroke: NoteDoodleStroke,
  width: number,
  height: number
): void {
  if (!stroke.points.length) return;
  const strokeWidth = Math.max(2, stroke.width);
  const opacity = clampNumber(stroke.opacity || 0.34, 0.08, 1, 0.34);
  const offsets = getNoteDoodlePenOffsets(Math.max(2, stroke.count + 1), strokeWidth * 0.85);

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = stroke.color;

  for (const [layerIndex, offset] of offsets.entries()) {
    context.globalAlpha = opacity * (layerIndex === 0 ? 0.46 : 0.22);
    context.lineWidth = strokeWidth * (layerIndex === 0 ? 2.15 : 1.55);
    context.beginPath();
    const first = noteDoodlePointToCanvas(stroke.points[0], width, height);
    context.moveTo(first.x + offset.x, first.y + offset.y);

    for (const point of stroke.points.slice(1)) {
      const next = noteDoodlePointToCanvas(point, width, height);
      context.lineTo(next.x + offset.x, next.y + offset.y);
    }

    context.stroke();
  }

  context.restore();
}

function noteDoodlePointToCanvas(point: NoteDoodlePoint, width: number, height: number): { x: number; y: number } {
  return {
    x: point.x * width,
    y: point.y * height
  };
}

function getNoteDoodlePenOffsets(count: number, width: number): Array<{ x: number; y: number }> {
  const safeCount = Math.round(clampNumber(count, 1, NOTE_DOODLE_MAX_PEN_COUNT, 1));
  if (safeCount <= 1) return [{ x: 0, y: 0 }];

  const radius = Math.max(2, Number(width || 3) * 1.15);
  const offsets = [{ x: 0, y: 0 }];

  for (let index = 1; index < safeCount; index += 1) {
    const angle = ((index - 1) / Math.max(1, safeCount - 1)) * Math.PI * 2;
    offsets.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    });
  }

  return offsets;
}

function getExcalidrawExportScaleCandidates(preferredScale: number): number[] {
  const candidates = [
    preferredScale,
    1.5,
    1.25,
    1,
    0.7,
    EXCALIDRAW_MIN_EXPORT_SCALE
  ];
  return Array.from(
    new Set(
      candidates
        .filter((scale) => Number.isFinite(scale))
        .map((scale) => Math.max(EXCALIDRAW_MIN_EXPORT_SCALE, Math.min(preferredScale, scale)))
        .map((scale) => Math.round(scale * 100) / 100)
    )
  ).sort((a, b) => b - a);
}

function getExcalidrawPngFallbackScaleCandidates(hasSvgApi: boolean): number[] {
  const candidates = hasSvgApi
    ? [0.7, EXCALIDRAW_MIN_EXPORT_SCALE]
    : [1, 0.7, EXCALIDRAW_MIN_EXPORT_SCALE];
  return Array.from(
    new Set(
      candidates
        .filter((scale) => Number.isFinite(scale))
        .map((scale) => Math.max(EXCALIDRAW_MIN_EXPORT_SCALE, Math.min(1, scale)))
        .map((scale) => Math.round(scale * 100) / 100)
    )
  ).sort((a, b) => b - a);
}

function getSvgSafeRasterScale(svg: SVGSVGElement, requestedScale: number): number {
  const { width, height } = getSvgRasterSize(svg);
  const maxSafeScale = Math.min(
    requestedScale,
    EXCALIDRAW_MAX_SLICE_WIDTH_PX / width,
    EXCALIDRAW_MAX_SLICE_HEIGHT_PX / height,
    Math.sqrt(EXCALIDRAW_MAX_SLICE_PIXELS / Math.max(1, width * height))
  );
  return Math.max(Number.EPSILON, Math.min(requestedScale, maxSafeScale));
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getSvgRasterSize(svg: SVGSVGElement): { width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  const width = Math.max(
    1,
    Math.ceil(
      rect.width ||
        svg.clientWidth ||
        parseSvgLength(svg.getAttribute("width")) ||
        viewBox.width ||
        16
    )
  );
  const height = Math.max(
    1,
    Math.ceil(
      rect.height ||
        svg.clientHeight ||
        parseSvgLength(svg.getAttribute("height")) ||
        viewBox.height ||
        16
    )
  );
  return { width, height };
}

function parseSvgLength(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadImage(url: string, timeoutMs = SVG_IMAGE_LOAD_TIMEOUT_MS): Promise<HTMLImageElement> {
  const image = new Image();
  let timeout = 0;
  await new Promise<void>((resolve, reject) => {
    timeout = window.setTimeout(() => reject(new Error("Image load timed out.")), timeoutMs);
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Image load failed."));
    image.src = url;
  }).finally(() => {
    window.clearTimeout(timeout);
  });
  return image;
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseCssColor(value: string): Color | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "transparent") return null;

  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/iu);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((part) => part.trim());
    const r = parseCssColorChannel(parts[0]);
    const g = parseCssColorChannel(parts[1]);
    const b = parseCssColorChannel(parts[2]);
    const a = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
    if ([r, g, b, a].every((part) => Number.isFinite(part)) && a > 0) {
      return rgb(r / 255, g / 255, b / 255);
    }
  }

  const hexMatch = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu);
  if (hexMatch) {
    const hex = hexMatch[1].length === 3
      ? Array.from(hexMatch[1]).map((char) => char + char).join("")
      : hexMatch[1];
    return rgb(
      Number.parseInt(hex.slice(0, 2), 16) / 255,
      Number.parseInt(hex.slice(2, 4), 16) / 255,
      Number.parseInt(hex.slice(4, 6), 16) / 255
    );
  }

  return null;
}

function parseCssColorChannel(value: string | undefined): number {
  if (!value) return Number.NaN;
  if (value.endsWith("%")) return (Number.parseFloat(value) / 100) * 255;
  return Number.parseFloat(value);
}

function outputColor(color: Color, colorMode: PdfColorMode): Color {
  if (colorMode !== "grayscale") return color;
  const channels = getPdfRgbChannels(color);
  if (!channels) return color;
  const gray = toGrayChannel(channels.red, channels.green, channels.blue);
  return rgb(gray, gray, gray);
}

function colorToCss(color: Color, colorMode: PdfColorMode): string {
  const channels = getPdfRgbChannels(outputColor(color, colorMode));
  if (!channels) return colorMode === "grayscale" ? "rgb(128, 128, 128)" : "rgb(0, 0, 0)";
  return `rgb(${Math.round(channels.red * 255)}, ${Math.round(channels.green * 255)}, ${Math.round(channels.blue * 255)})`;
}

function getPdfRgbChannels(color: Color): { red: number; green: number; blue: number } | null {
  const candidate = color as Partial<{ red: number; green: number; blue: number }>;
  if (
    typeof candidate.red === "number" &&
    typeof candidate.green === "number" &&
    typeof candidate.blue === "number"
  ) {
    return {
      red: clampNumber(candidate.red, 0, 1, 0),
      green: clampNumber(candidate.green, 0, 1, 0),
      blue: clampNumber(candidate.blue, 0, 1, 0)
    };
  }
  return null;
}

function toGrayChannel(red: number, green: number, blue: number): number {
  return clampNumber(red * 0.2126 + green * 0.7152 + blue * 0.0722, 0, 1, 0);
}

function applyCanvasGrayscale(context: CanvasRenderingContext2D, width: number, height: number): void {
  try {
    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let index = 0; index < data.length; index += 4) {
      const gray = Math.round(data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722);
      data[index] = gray;
      data[index + 1] = gray;
      data[index + 2] = gray;
    }
    context.putImageData(imageData, 0, 0);
  } catch (error) {
    console.warn("Mobile PDF Exporter grayscale conversion failed", error);
  }
}

function cleanupRenderRoots(): void {
  for (const root of Array.from(activeDocument.querySelectorAll(".mobile-pdf-exporter-render-root"))) {
    root.remove();
  }
}

function createCanvas(owner: Node | Document): HTMLCanvasElement {
  const ownerDocument = owner.ownerDocument ?? owner as Document;
  return ownerDocument.createElement("canvas");
}

async function waitForPromiseOrTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout = 0;
  type PromiseRaceResult =
    | { kind: "resolved"; value: T }
    | { kind: "rejected"; error: unknown }
    | { kind: "timeout" };
  const guardedPromise: Promise<PromiseRaceResult> = promise.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );
  const timeoutPromise = new Promise<PromiseRaceResult>((resolve) => {
    timeout = window.setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });

  const result = await Promise.race([guardedPromise, timeoutPromise]).finally(() => {
    window.clearTimeout(timeout);
  });

  if (result.kind === "timeout") {
    console.warn(`Mobile PDF Exporter preview render timed out after ${timeoutMs}ms; using rendered DOM so far.`);
    return null;
  }
  if (result.kind === "rejected") throw result.error;
  return result.value;
}

async function waitForRenderedContent(container: HTMLElement, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (hasRenderedContent(container)) return;
    await nextAnimationFrame();
  }
  console.warn(`Mobile PDF Exporter rendered content wait timed out after ${timeoutMs}ms.`);
}

function getPreviewWaitProfile(container: HTMLElement): {
  renderedContentMs: number;
  initialStableMs: number;
  finalStableMs: number;
} {
  const imageCount = container.querySelectorAll("img").length;
  const svgCount = container.querySelectorAll("svg").length;
  const heavyBlockCount = container.querySelectorAll("table, pre, blockquote, .callout, .markdown-embed, .internal-embed").length;
  const textLength = container.textContent?.length ?? 0;
  const complexity = imageCount * 3 + svgCount * 3 + heavyBlockCount * 2 + Math.min(8, Math.floor(textLength / 2500));

  return {
    renderedContentMs: complexity > 8 ? 1200 : 520,
    initialStableMs: complexity > 14 ? 5200 : complexity > 6 ? 2600 : 1100,
    finalStableMs: complexity > 10 ? 1100 : 420
  };
}

async function waitForPreviewDomStable(container: HTMLElement, timeoutMs: number): Promise<void> {
  const started = Date.now();
  const minWaitMs = Math.min(420, Math.max(120, timeoutMs * 0.08));
  const stableForMs = Math.min(520, Math.max(180, timeoutMs * 0.16));
  let lastSignature = getPreviewDomSignature(container);
  let lastChangedAt = Date.now();

  const observer = new MutationObserver(() => {
    const signature = getPreviewDomSignature(container);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastChangedAt = Date.now();
    }
  });

  observer.observe(container, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true
  });

  try {
    while (Date.now() - started < timeoutMs) {
      await nextAnimationFrame(Math.min(180, FRAME_WAIT_TIMEOUT_MS));
      const signature = getPreviewDomSignature(container);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastChangedAt = Date.now();
      }

      const waitedLongEnough = Date.now() - started >= minWaitMs;
      const stableLongEnough = Date.now() - lastChangedAt >= stableForMs;
      if (waitedLongEnough && stableLongEnough && hasRenderedContent(container)) return;
    }
  } finally {
    observer.disconnect();
  }

  console.warn(`Mobile PDF Exporter preview DOM stability wait timed out after ${timeoutMs}ms.`);
}

function getPreviewDomSignature(container: HTMLElement): string {
  return [
    container.textContent?.length ?? 0,
    container.querySelectorAll("img").length,
    container.querySelectorAll("svg").length,
    container.querySelectorAll("li, table, pre, blockquote, .callout, .markdown-embed, .internal-embed, .block-language-tasks").length,
    Math.round(container.scrollHeight),
    Math.round(container.getBoundingClientRect().height)
  ].join("|");
}

function hasRenderedContent(container: HTMLElement): boolean {
  if (container.textContent?.trim()) return true;
  return !!container.querySelector("img, svg, canvas, table, li, pre, blockquote, .callout, .markdown-embed, .internal-embed");
}

function hasExportableContent(container: HTMLElement): boolean {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (!isExportableElement(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  if (walker.nextNode()) return true;
  return Boolean(
    Array.from(container.querySelectorAll<HTMLElement | SVGSVGElement>("img, svg, canvas, table, li, blockquote, .callout, .markdown-embed, .internal-embed"))
      .some((element) => isExportableElement(element))
  );
}

async function waitForPreviewFonts(container: HTMLElement, timeoutMs: number): Promise<void> {
  const fonts = container.ownerDocument.fonts;
  if (!fonts?.ready) return;
  await Promise.race([
    fonts.ready.then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs))
  ]);
  await nextAnimationFrame();
}

async function waitForImages(container: HTMLElement, timeoutMs: number): Promise<void> {
  const images = Array.from(container.querySelectorAll("img"))
    .filter((image) => !image.complete);
  if (!images.length) return;
  const adaptiveTimeout = Math.min(timeoutMs, Math.max(360, images.length * 260));
  const imagePromise = Promise.all(
    images.map(async (image) => {
      await new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      });
    })
  );

  await waitForPromiseOrTimeout(imagePromise, adaptiveTimeout);
}

async function nextAnimationFrame(timeoutMs = FRAME_WAIT_TIMEOUT_MS): Promise<void> {
  let frame = 0;
  let timeout = 0;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      resolve();
    };
    frame = window.requestAnimationFrame(finish);
    timeout = window.setTimeout(finish, timeoutMs);
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
