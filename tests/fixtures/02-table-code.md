# 표와 코드 블록

| 항목 | 상태 | 설명 |
|:---|:---:|---:|
| 한글 선택 | 완료 | 검색·복사 가능한 실제 텍스트 |
| 테마 보존 | 검증 | 셀 배경과 테두리 및 정렬 |
| 긴 셀 | 진행 | 아주 긴 한글 문장이 표 셀 안에서 어떻게 줄바꿈되는지 확인하기 위한 내용입니다. 가나다라 마바사 아자차카 타파하. |

아래 코드는 선행 공백, 연속 공백, 탭과 구문 강조를 확인합니다.

```typescript
function PDF_내보내기(note: string) {
    const message = "연속  공백과    들여쓰기";
    if (note.length > 0) {
        return `${message}: ${note}`;
    }
    return "빈 노트";
}
```

긴 한 줄 코드:

```text
https://example.com/very/long/path/that/should/follow/the/current/obsidian/code-block/overflow/behavior?한글=가나다라마바사아자차카타파하
```

TABLE_CODE_SENTINEL_END
