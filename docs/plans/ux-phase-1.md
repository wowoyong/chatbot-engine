# Phase 1: 서버 SSE(sources/usage) + CLI 푸터

@fidelity-check tokens: event: sources, TurnMeta, promptTokens, driveSend

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수
2. `any` 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성

## 전제 조건

Phase 0이 노출한 인터페이스 (그대로 복사):

```ts
// src/chat/session.ts
export interface SourceRef { source: string; heading: string; }
export interface TurnMeta { sources: SourceRef[]; promptTokens?: number; responseTokens?: number; }
// send(userInput, options?): AsyncGenerator<string, TurnMeta>
```

## 현재 상태

서버·CLI 모두 `for await (piece of send())`로 소비해 return(TurnMeta)을 버린다. 수동 iterate로 메타를 포착해 SSE 이벤트/푸터로 노출한다.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| App (createApp overrides) | ✓ | ✓ (Fake client) | 기존 서버 테스트 패턴 |
| Fake client 통계 | ✓ | ✓ (generator return) | — |
| stdin/stdout (CLI) | ✗ | ✗ | 얇은 레이어 — 서버 테스트가 wire 커버 |

## Step 1: 서버 SSE 확장 (`src/server/http-server.ts` — modify, 스트리밍 블록 교체)

### Context

`for await` 소비를 수동 iterate로 교체 — content는 `data:{piece}` 유지, 완료 시 return된 TurnMeta로 (a) content 전 `event:sources`(있을 때), (b) `event:done data:{usage}` 전송. 클라이언트 중단(`res.destroyed`) 감지 유지.

### Code

교체 전:
```ts
    try {
      for await (const piece of app.session.send(message)) {
        if (res.destroyed) {
          return; // 클라이언트 중단 — 제너레이터 조기 종료로 히스토리 미기록
        }
        res.write(`data: ${JSON.stringify({ piece })}\n\n`);
      }
      await app.store.save(app.session.getHistory());
      res.write('event: done\ndata: {}\n\n');
    } catch (err) {
```

교체 후:
```ts
    try {
      const iterator = app.session.send(message)[Symbol.asyncIterator]();
      let sourcesSent = false;
      let result = await iterator.next();
      while (result.done !== true) {
        if (res.destroyed) {
          return; // 클라이언트 중단 — 제너레이터 조기 종료로 히스토리 미기록
        }
        res.write(`data: ${JSON.stringify({ piece: result.value })}\n\n`);
        result = await iterator.next();
      }
      const meta = result.value;
      if (!sourcesSent && meta.sources.length > 0) {
        sourcesSent = true;
      }
      await app.store.save(app.session.getHistory());
      if (meta.sources.length > 0) {
        res.write(`event: sources\ndata: ${JSON.stringify({ sources: meta.sources })}\n\n`);
      }
      res.write(
        `event: done\ndata: ${JSON.stringify({ promptTokens: meta.promptTokens, responseTokens: meta.responseTokens })}\n\n`,
      );
    } catch (err) {
```

### Anchor

교체 전 블록 (파일 내 유일 — `for await (const piece of app.session.send(message))` 포함).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 137 passed (기존 서버 테스트 — done 이벤트 data 형식 변경분은 Step 3에서 갱신)
# 3. 의미 검증
grep -c "event: sources" src/server/http-server.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

done 이벤트의 data가 `{}`→`{promptTokens,responseTokens}`로 변경 → 기존 서버 테스트의 done 검증이 `toContain('event: done')`이면 무영향, 정확 매칭이면 Step 3에서 갱신. sources 이벤트 테스트는 Step 3.

### Do Not Touch

라우트 dispatch, handleChat 외 함수.

## Step 2: CLI 푸터 (`src/cli/main.ts` — modify, 스트리밍 블록 교체)

### Context

CLI도 수동 iterate로 메타 포착 → 응답 뒤에 출처·토큰 푸터를 dim하게 출력.

### Code

교체 전:
```ts
      for await (const piece of app.session.send(line)) {
        stdout.write(piece);
      }
      stdout.write('\n');
      await app.store.save(app.session.getHistory());
```

교체 후:
```ts
      const iterator = app.session.send(line)[Symbol.asyncIterator]();
      let result = await iterator.next();
      while (result.done !== true) {
        stdout.write(result.value);
        result = await iterator.next();
      }
      stdout.write('\n');
      const meta = result.value;
      if (meta.sources.length > 0) {
        const labels = meta.sources
          .map((s) => (s.heading.length > 0 ? `${s.source} > ${s.heading}` : s.source))
          .join(', ');
        stdout.write(`  출처: ${labels}\n`);
      }
      if (meta.responseTokens !== undefined) {
        stdout.write(
          `  토큰: prompt ${meta.promptTokens ?? '?'} / response ${meta.responseTokens}\n`,
        );
      }
      await app.store.save(app.session.getHistory());
```

### Anchor

교체 전 블록 (파일 내 유일 — `for await (const piece of app.session.send(line))` 포함).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 137 passed
# 3. 의미 검증
printf '/exit\n' | npx tsx src/cli/main.ts | head -1
  # 기대: 배너 정상 출력 (CLI 테스트 면제 — 얇은 레이어)
```

### 동반 변경 (Side Effects)

CLI는 테스트 면제(Segment 1과 동일 사유 — 얇은 I/O 레이어, 로직은 Phase 0 세션 테스트 + Step 3 서버 테스트가 커버).

### Do Not Touch

명령 dispatch(/exit·/clear·/index·/capture), 에러 처리.

## Step 3: 서버 SSE 테스트 (`src/server/__tests__/http-server.test.ts` — modify, Fake 통계 + 케이스 추가)

### Context

기존 FakeLlmClient의 chatStream이 통계를 return하도록 확장(기존 케이스는 pieces만 보므로 무영향), sources/usage 이벤트 검증 케이스 추가.

### Code

(a) FakeLlmClient의 chatStream 메서드 교체 —

교체 전:
```ts
  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    for (const piece of this.pieces) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.fail) {
        throw new Error('llm down');
      }
      yield piece;
    }
  }
```

교체 후:
```ts
  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }> {
    for (const piece of this.pieces) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.fail) {
        throw new Error('llm down');
      }
      yield piece;
    }
    return { promptTokens: 11, responseTokens: 22 };
  }
```

(b) describe 닫는 `});` 바로 위에 추가:

### 검증 대상
- spy: SSE 프레임 텍스트
- branch: usage가 done 이벤트에 포함, retriever 없으면 sources 이벤트 없음
- state: done data의 promptTokens/responseTokens

```ts
  it('done 이벤트에 토큰 usage를 담는다 (정상)', async () => {
    const res = await postChat('질문');
    const text = await res.text();
    expect(text).toContain('event: done');
    expect(text).toContain('"promptTokens":11');
    expect(text).toContain('"responseTokens":22');
  });

  it('retriever가 없으면 sources 이벤트를 보내지 않는다 (경계값)', async () => {
    const res = await postChat('질문');
    const text = await res.text();
    expect(text).not.toContain('event: sources');
  });
```

### Anchor

- (a) FakeLlmClient의 chatStream (교체 전 텍스트 유일)
- (b) describe 닫는 `});` 바로 위 (기존 케이스 수정 금지)

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 139 passed (137 + 2)
# 3. 의미 검증
grep -c "promptTokens.:11\|event: sources" src/server/__tests__/http-server.test.ts
  # 기대: 2 이상
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

기존 서버 테스트 케이스 본문.

## 실행 순서

Step 1 → 2 → 3.

## 입출력 예제

| 요청 | SSE 프레임 |
|------|-----------|
| retriever 있음 | `data:{piece}`... `event:sources data:{sources}` `event:done data:{promptTokens,responseTokens}` |
| retriever 없음 | `data:{piece}`... `event:done data:{usage}` (sources 없음) |

## 이 Phase 완료 후 노출 인터페이스

```ts
// SSE 계약 (wire): data:{piece} / event:sources data:{sources:SourceRef[]} / event:done data:{promptTokens?,responseTokens?} / event:error data:{error}
// CLI: 응답 후 "출처:" / "토큰:" 푸터
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify ✓
- [ ] DoD-12: typecheck exit 0
- [ ] DoD-13: `npm test` 139 passed (기존 137 회귀 없음)
- [ ] DoD-14: usage·sources 이벤트 테스트 동반
- [ ] DoD-15: 문서 갱신 불필요 (Phase 2 UI 후 일괄)
- [ ] DoD-16: Phase 2 전제 만족

## Observability plan

N/A — 토큰/출처가 곧 관찰 노출.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS"
```
