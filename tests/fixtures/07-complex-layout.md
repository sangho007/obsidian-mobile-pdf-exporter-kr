# 복합 레이아웃과 미디어

COMPLEX_LAYOUT_SENTINEL_START

> [!warning] 바깥 경고
> 긴 한글 설명과 **굵게**, *기울임*, ==강조==, `inline code`를 함께 렌더링합니다.
> > [!tip] 안쪽 팁
> > 중첩 인용과 콜아웃 경계가 겹치지 않아야 합니다.
> > > 세 번째 중첩 인용문입니다.

1. 첫 단계
   1. 두 번째 단계
      - 세 번째 단계
        - 네 번째 단계의 매우 긴 한글 목록 항목입니다. 가나다라마바사아자차카타파하를 반복해서 자연스러운 줄바꿈과 들여쓰기를 함께 확인합니다.
2. 체크 상태
   - [x] 완료 항목
   - [ ] 미완료 항목
   - [x] **굵은 항목**과 `코드`

<table>
  <thead>
    <tr><th rowspan="2">병합 행</th><th colspan="3">병합 열 COMPLEX_TABLE_SENTINEL</th></tr>
    <tr><th>한글</th><th>숫자</th><th>긴 설명</th></tr>
  </thead>
  <tbody>
    <tr><td rowspan="2">A<br>B</td><td>가나다</td><td>1234567890</td><td>긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용긴셀내용</td></tr>
    <tr><td>라마바</td><td>0.000001</td><td><mark>표시</mark> <del>취소</del> <code>셀 코드</code></td></tr>
  </tbody>
</table>

<details open>
<summary>열린 상세 영역</summary>

상세 본문에는 <span style="background:linear-gradient(90deg,#ffe066,#74c0fc);border-radius:8px;padding:4px 8px">그라디언트 인라인</span>과 긴 문장이 있습니다.
</details>

## 정상 로컬 SVG

![[test-gradient.svg]]

## 대형 SVG 다운스케일

![[adversarial-large.svg]]

## 의도적으로 없는 임베드

![[missing-adversarial-image.png]]

```javascript
function 악의입력(value) {
	const 매우긴식별자_한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글한글 = value ?? "기본값";
	return { value, emoji: "😀", oldHangul: "ᄒᆞᆫ글" };
}
```

COMPLEX_LAYOUT_SENTINEL_END
