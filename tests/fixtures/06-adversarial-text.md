# 악의적 텍스트 조합

TEXT_ADV_SENTINEL_START

## 매우 긴 무공백 한글

가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하

## 매우 긴 URL과 혼합 방향

<https://example.com/very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-very-long-segment-?한글=선택가능&value=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA>

왼쪽→오른쪽 English 123 / 오른쪽 혼합 العربية עברית / 다시 한글 TEXT_DIRECTION_SENTINEL

## Grapheme와 미지원 문자 사이 좌표

NFC: 가나다라마바사 / NFD: 가 나 다 / 옛한글: ᄒᆞᆫ글 ᄀᆞᆯ / 결합: é Å / ZWJ: 👨‍👩‍👧‍👦 👩🏽‍💻 / 국기: 🇰🇷🇺🇸

미지원 혼합 앞: 앞漢字😀🧪중간مرحبا🚀뒤

## 인라인 경계와 크기

<strong>굵은한글</strong> <em>기울임한글</em> <mark>표시한글</mark> <del>취소한글</del><small>아주작은글자</small><sup>위첨자</sup><sub>아래첨자</sub>

`인라인  공백    코드`와 <kbd>키보드</kbd>, <u>밑줄</u>, <span style="letter-spacing:-0.12em">매우좁은자간가나다라마바사</span>

```text
첫째 줄
    공백 네 칸
	탭 한 칸 뒤 한글
연속        공백과 아주긴코드행_코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드코드
```

TEXT_ADV_SENTINEL_END
