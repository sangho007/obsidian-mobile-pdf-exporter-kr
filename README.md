# Mobile PDF Exporter KR

아이패드·아이폰·데스크톱 Obsidian에서 현재 노트를 **한글 검색·선택·복사가 가능한 PDF**로 내보내는 무료 플러그인입니다.

별도 iOS 앱, 서버, 계정, 유료 API 없이 기기 안에서 동작합니다.

이 프로젝트는 [arias007/obsidian-mobile-pdf-exporter](https://github.com/arias007/obsidian-mobile-pdf-exporter)의 한국어 글꼴 포크입니다. 원본의 미리보기 렌더링, 페이지 분할, 이미지·링크·콜아웃 처리와 Excalidraw 지원을 유지합니다.

## 한국어 포크에서 달라진 점

- `Noto Sans CJK KR` TrueType 글꼴을 정적 Regular 두께로 변환·서브셋해 gzip으로 번들에 포함합니다.
- 현대 한글 11,172자 전체, 한글 자모·호환 자모·확장 자모를 포함합니다.
- 영문, 일반 문장부호, 통화·수학·화살표 기호를 함께 포함합니다.
- iPad의 언어가 한국어이면 플러그인 UI도 자동으로 한국어를 사용합니다.
- 플러그인 ID를 `mobile-pdf-exporter-kr`로 분리해 원본 업데이트가 이 포크를 덮어쓰지 않습니다.

선택형 PDF는 Obsidian 미리보기를 페이지 이미지로 보존하고, 그 위에 보이지 않는 실제 PDF 텍스트 레이어를 배치합니다. 따라서 테마와 복잡한 렌더링을 유지하면서 한글 검색·선택·복사가 가능합니다.

## 0.1.2 페이지 경계 수정

A4 페이지 끝을 1px 미만으로 넘는 한글 획이나 영문 descender까지 감지해 문장 전체를 다음 페이지로 이동합니다. 마지막 소수점 꼬리도 별도 페이지에 보존하며, 블록 회피로 옮긴 새 경계가 앞줄을 다시 자르지 않는지 반복 확인합니다.

## 0.1.1 렌더링 개선

- 브라우저가 Obsidian 미리보기 DOM의 계산된 스타일과 가상 요소를 직접 그려 인라인 코드·강조·취소선·표·콜아웃·그림자·그라디언트를 더 가깝게 보존합니다.
- 선택 텍스트는 grapheme와 실제 DOM 좌표 단위로 배치하며, 인라인 태그 사이 공백과 CSS 공백 모드의 연속·앞뒤 공백도 유지합니다.
- 비균일 페이지 구간을 중복 캡처하지 않고, 이미지·Canvas·CSS·글꼴 리소스와 문서 전체 페이지 래스터에는 iPad용 메모리 상한을 적용합니다.
- DOM 스냅샷을 안전하게 만들 수 없는 노트는 내장 호환 렌더러로 자동 전환합니다.

전체 변경점은 [CHANGELOG.md](CHANGELOG.md)를 참조하세요.

## 설치

### iPad에서 권장: BRAT

iPad의 기본 파일 앱은 숨김 폴더인 `.obsidian`을 표시하지 않으므로 BRAT으로
설치하는 방식이 가장 간단합니다.

1. Obsidian에서 무료 커뮤니티 플러그인 `BRAT`을 설치하고 켭니다.
2. BRAT 설정에서 `Add Beta plugin`을 누릅니다.
3. 다음 저장소 주소를 입력합니다.

```text
https://github.com/sangho007/obsidian-mobile-pdf-exporter-kr
```

4. 설치가 끝나면 `설정 → 커뮤니티 플러그인 → Mobile PDF Exporter KR`을
   켭니다.

BRAT은 `manifest.json`, `main.js`, `styles.css`를 직접 설치합니다. 글꼴과
모든 필수 라이선스 고지는 `main.js` 안에 포함되어 있어 추가 파일이나
네트워크 글꼴 다운로드가 필요 없습니다.

### ZIP 수동 설치

릴리스 압축 파일을 풀어 다음 폴더에 넣습니다.

```text
<볼트>/.obsidian/plugins/mobile-pdf-exporter-kr/
```

최소 구성은 다음과 같습니다.

```text
mobile-pdf-exporter-kr/
├── manifest.json
├── main.js
└── styles.css
```

글꼴은 `main.js`에 압축 상태로 포함되어 있어 별도 다운로드가 필요 없습니다. 기본 파일 앱만으로는 `.obsidian` 폴더에 접근할 수 없으므로 수동 설치에는 숨김 폴더를 다룰 수 있는 파일 관리 도구가 필요합니다. 릴리스 ZIP에는 복구와 검증을 위한 로컬 글꼴 `fonts/NotoSansCJKkr-Regular.ko-subset.ttf`도 함께 들어 있습니다.

Obsidian을 다시 시작한 뒤 `설정 → 커뮤니티 플러그인 → Mobile PDF Exporter KR`을 켭니다. 원본 `Mobile PDF Exporter`가 이미 설치되어 있다면 메뉴 중복을 피하도록 원본은 끄는 것을 권장합니다.

## 사용법

1. Markdown 노트를 엽니다.
2. 리본 버튼, 노트 메뉴 또는 명령 팔레트에서 `미리보기 PDF 내보내기`를 실행합니다.
3. `내보내기 방식 → 선택 가능 텍스트`를 선택합니다.
4. A4/A5/Letter/모바일 페이지, 방향, 여백과 배율을 정합니다.
5. `PDF 내보내기`를 누릅니다.

기본 출력 위치는 볼트의 `PDF Exports` 폴더입니다. 첫 사용 후 PDF에서 `가나다라마바사`를 검색하고 복사해 한글 텍스트 레이어가 정상인지 확인하세요.

## 글꼴 범위와 재현 빌드

생성된 글꼴:

```text
fonts/NotoSansCJKkr-Regular.ko-subset.ttf
fonts/NotoSansCJKkr-Regular.ko-subset.ttf.gz
```

원본 글꼴은 공식 [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk)의 고정 커밋 `523d033d6cb47f4a80c58a35753646f5c3608a78`에 있는 `Sans/Variable/TTF/NotoSansCJKkr-VF.ttf`입니다. 이 포크를 만들 때 사용한 원본 파일의 SHA-256은 다음과 같습니다.

```text
7715af52f5fe77153ce5678546258993982d2da61abea8d25fb89eb5aaec5ca6
```

HarfBuzz의 `hb-subset`이 설치된 환경에서 다시 만들 수 있습니다.

```bash
npm run build:font -- /path/to/NotoSansCJKkr-VF.ttf
```

생성 스크립트는 가변 글꼴을 `wght=400`의 정적 TrueType으로 고정한 뒤 현대·옛한글과 일반 문서 기호만 남깁니다. iPad 메모리 사용량을 줄이기 위해 대규모 한자·중국어 범위는 넣지 않습니다. 출력 TTF의 SHA-256은 `086930ba7df8c78de017cf609e8e23dbf4374074656f559f0cd617c803153ad5`입니다.

## 개발과 검증

```bash
npm ci
npm run build
npm test
npm run test:a4-boundary-clipping
npm run test:render-fidelity
# macOS에서 실제 WKWebView 경로까지 추가 검증
npm run test:render-fidelity-webkit
npm run test:apple-pdfkit
```

`test:korean-font`는 한글·영문·옛한글 자모와 미지원 한자·이모지가 섞인 PDF를 생성하고, Poppler의 `pdftotext`, `pdffonts`, `pdftoppm`으로 텍스트 추출·TrueType 임베딩·실제 한글 윤곽 렌더링을 모두 검사합니다. `test:a4-boundary-clipping`은 A4 경계 악조건을 실제 선택형 PDF로 만들고 글리프 잉크량·높이·중복·텍스트 추출을 검사합니다. `test:render-fidelity`는 Chrome에서 Obsidian형 fixture와 DOM 스냅샷을 픽셀·기능 영역별로 비교합니다. macOS 전용 `test:render-fidelity-webkit`은 같은 fixture를 실제 `WKWebView`에서 다시 실행하고 전 페이지 픽셀 비교를 수행합니다. `test:apple-pdfkit`은 숨은 한글 텍스트가 macOS PDFKit에서도 검색·선택되며 화면에는 중복 표시되지 않는지 검사합니다. 미지원 문자가 같은 문장에 있어도 한글은 남아야 합니다. Poppler 실행 파일이 PATH에 없다면 다음처럼 위치를 지정합니다.

```bash
PDFTOTEXT=/path/to/pdftotext npm run test:korean-font
```

검증 PDF는 `dist/korean-selectable-smoke.pdf`에 생성됩니다.

실제 Obsidian 통합 검증용 새 볼트도 만들 수 있습니다. 생성된 경로를 Obsidian으로 열어 8개 fixture를 `PDF Exports`에 내보낸 뒤 두 번째 명령으로 텍스트 순서·공백·페이지 경계·A4 크기·Noto 글꼴 임베딩과 모든 페이지 렌더를 검사합니다.

```bash
npm run prepare:test-vault
npm run verify:test-vault-pdfs -- /absolute/path/to/generated-vault
```

## 개인정보와 네트워크

노트 렌더링, PDF 생성과 글꼴 로딩은 모두 기기 안에서 이루어집니다. 이미 Obsidian이 표시 중인 로컬·동일 출처 리소스를 PDF에 포함하기 위해 기기 내부 URL을 읽을 수 있지만, 플러그인이 노트 내용을 외부 서버로 전송하거나 유료 API를 호출하지는 않습니다. 최신 WebView에서는 기본 gzip 해제 기능을 쓰고, 이를 지원하지 않는 구형 WebView에서는 번들된 JavaScript 대체 구현을 사용합니다.

## 제한 사항

- 선택형 PDF의 화면 모양은 래스터 이미지이고, 검색·선택용 텍스트 레이어가 별도로 들어갑니다. 따라서 구조화 PDF/PDF-UA를 보장하지 않습니다.
- 컬러 이모지는 글꼴 범위에 포함되지 않으며 화면 이미지로만 보일 수 있습니다.
- 한자·중국어 본문은 iPad 메모리를 아끼기 위해 선택 텍스트 글꼴에서 제외했으며 화면 이미지에는 그대로 보입니다.
- 매우 긴 노트는 iPad 메모리 한계 때문에 낮은 이미지 품질이나 작은 내용 배율이 필요할 수 있습니다.
- Dataview나 다른 플러그인이 비동기로 렌더링하는 내용은 캡처 시점에 따라 달라질 수 있습니다.

## 라이선스

- 플러그인 코드: [MIT](LICENSE)
- Noto Sans CJK KR 및 생성된 하위 글꼴: [SIL Open Font License 1.1](fonts/LICENSE-OFL.txt)
- 번들 JavaScript의 제3자 코드·데이터: MIT, HarfBuzz Old MIT, Apache-2.0, BSD-3-Clause, ISC, Zlib, 0BSD, Unicode-DFS-2016. 구성 목록은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), 전체 고지는 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)를 참조하세요.

원본 프로젝트의 저작권과 라이선스 고지를 유지합니다. BRAT 설치본에도 같은 고지가 전달되도록 전체 고지문을 빌드된 `main.js` 첫 부분에 평문 주석으로 보존합니다.
