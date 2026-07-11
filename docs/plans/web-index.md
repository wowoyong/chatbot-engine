# web — Implementation Plan Index

Baseline: main@17f680b (clean)
(미커밋 파일은 본 plan 문서 4개뿐 — src 기준 clean, Segment 4 + knowledge 시딩 landing 완료 상태)

## 개요

Segment 5 — HTTP API 서버(`node:http` 밑바닥, SSE 스트리밍)와 바닐라 웹 UI. CLI와 서버가 공유하는 조립 로직을 `createApp`으로 추출해 엔진/인터페이스 분리를 완성한다. 세션 모델(단일 공유 세션)은 사용자 승인 완료. 배포 대상은 맥미니 16GB(qwen3:8b 고정, `HOST=0.0.0.0`로 LAN 노출).

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | bootstrap 추출 | 4 (신규 2, 수정 2) | 없음 | createApp + CLI 리팩터 + OllamaClient.model 공개 + 테스트 4 |
| 1 | HTTP 서버 | 2 (신규) | Phase 0 | SSE 채팅 + history/clear/index 라우트 + 테스트 8 |
| 2 | 웹 UI + 엔트리 | 4 (신규 2, 수정 2) | Phase 1 | index.html, main.ts, package.json(serve/build), CLAUDE.md |

## 실행 순서

Phase 0 → 1 → 2 (순차).

## Segment 경계 (Out-of-Scope — 사전 분석 보고에서 승인)

- 멀티 세션(탭별 대화) — 단일 공유 세션 승인, 세션 ID 체계는 필요 시 후속
- 인증/HTTPS — 개인 LAN 서버. 공개 인터넷 노출 시 별도 segment (기본 바인딩 127.0.0.1로 안전측)
- 대화 이력의 knowledge-capture 처리 — Segment 5.5 (본 segment는 훅 포인트인 `GET /api/history`까지만)
- WebSocket — SSE로 충분 (단방향 스트림), 양방향 필요 시 재검토

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `grep -rn "ChatSession\|OllamaClient\|Retriever\|SessionStore\|VectorIndex\|buildIndex" src/cli/main.ts \| wc -l` | 14 hits — 조립 로직이 CLI에 인라인 | In-Scope (1) — createApp으로 추출, 서버와 공유 (Phase 0) |
| Adjacent Files (인접 파일) | OllamaEmbedder는 `readonly model` 공개 / OllamaClient는 private | 형제 비대칭 1건 | In-Scope (1) — OllamaClient.model 공개로 parity (Phase 0 Step 1) |
| Byproducts (부산물) | `npm run build` 산출 확인 — tsc는 html 미복사 | 1건 (dist 실행 시 GET / 404 위험) | In-Scope (1) — build 스크립트에 복사 스텝 (Phase 2 Step 3) |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/chat/**`, `src/context/**`, `src/rag/**`, `src/store/**`, `src/llm/*` (ollama-client 1줄 제외), `docs/plans/{core-engine,memory,rag,openwiki}-*.md` | 엔진 코어 무변경 — 본 segment는 조립·인터페이스 레이어만 |
| **Touch-Minimal** | `src/llm/ollama-client.ts` (private→readonly 1줄), `CLAUDE.md` (1줄), `package.json` (serve/build만) | 본 변경 외 재수정 금지 |
| **Full Scope** | `src/app/**` (신규), `src/server/**` (신규), `src/cli/main.ts` (전체 교체) | 통상 품질 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan 전부 구현 완료·landing. 동시 landing 형제 없음.

## BE-FE 계약 경계 (1-3.H)

활성 — 본 segment가 BE(서버)↔FE(브라우저) 경계를 처음 도입:
- **wire 계약**: SSE 프레임 `data: {"piece": string}` / `event: done` / `event: error {"error": string}` — 서버(Phase 1 Step 1)와 UI 파서(Phase 2 Step 1 handleFrame)가 동일 명세 참조, 서버 테스트가 프레임 형식을 문자열 수준에서 고정
- **history 계약**: `{history: ChatMessage[]}` — ChatMessage는 shared 타입(src/llm/types.ts) 단일 소스, UI는 role 필드만 소비
- **null/에러 표시**: HTTP 200 이후 실패는 상태코드 전달 불가 → error 이벤트로 명세 (UI가 "오류: … 다시 시도하세요" 렌더)

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | 클라이언트 탭 닫힘으로 스트림 중단 | M | L | `res.destroyed` 감지 → 제너레이터 조기 종료 → 히스토리 미기록 원칙 재사용 |
| R2 | 동시 채팅 요청으로 세션 경합 | M | M | `chatting` 가드 409 + UI 버튼 disabled 이중 방어 (테스트 동반) |
| R3 | 모델 출력에 HTML 포함 → XSS | L | M | UI 전 렌더를 `textContent`로 강제 (innerHTML 0건 — Verify grep) |
| R4 | 채팅 중 서버 종료 | L | L | 세션 저장은 턴 완료 시에만 — 파일 무손상 (기존 설계) |
| R5 | CLI 리팩터 회귀 | L | M | 기존 80 테스트 + 출력 문구 동일 유지 + 수동 스모크 |

## Acceptance Criteria

- [ ] AC1: 브라우저에서 메시지 전송 → 응답이 스트리밍 렌더 (수동)
- [ ] AC2: 웹↔CLI 세션 공유 — 새로고침·CLI 재진입에도 대화 유지 (수동)
- [ ] AC3: 생성 중 두 번째 채팅 요청 409 (단위 테스트 — Phase 1)
- [ ] AC4: 스트림 실패 시 error 이벤트 + 서버 생존 (단위 테스트 — Phase 1)
- [ ] AC5: 웹 재인덱싱 버튼 동작 (수동 + 라우트 단위 테스트)
- [ ] AC6: `npm test` 92 passed — 기존 80 회귀 없음

## Decision log + Alternatives considered

| 결정 | 선택 이유 | 검토했으나 안 한 대안 |
|------|----------|--------------------|
| `node:http` 밑바닥 | 의존성 0 원칙 + HTTP/SSE wire 학습 | Fastify/Express — Segment 6 프레임워크 비교 소재로 보류 |
| SSE over POST fetch | 단방향 스트림에 충분, wire format 학습 | WebSocket(과잉) / EventSource(GET 전용이라 본문 전달 불가) |
| 단일 공유 세션 + 409 가드 | 개인 서버, CLI와 기억 공유 (승인됨) | 탭별 세션 — 멀티세션 관리 범위 증가 |
| createApp(env 인자) | `process.env` 직접 참조 금지 → 테스트에서 env 주입 | 전역 참조 — 테스트 격리 불가 |
| Fake 주입은 overrides 파라미터 | 서버 테스트가 실제 HTTP 왕복으로 SSE까지 검증 | 라우트 함수 단위 테스트 — wire 검증 누락 |
| UI 렌더 textContent 강제 | 모델 출력 XSS 원천 차단 | sanitize 라이브러리 — 의존성 + 과잉 |
| 서버는 LlmConnectionError에도 생존 | 서버 프로세스와 모델 프로세스는 수명 분리 | CLI처럼 exit — 웹 서버에 부적합 |

## YAGNI 체크

- 추가 발견 추상화: 라우터 프레임워크화, 미들웨어 체인, 정적 파일 디렉토리 서빙(파일 1개뿐), CORS 설정(동일 출처만), 요청 로깅
- 사용자 결정: **N (전부 제외)** — 라우트 5개는 if 분기면 충분

## Rollback plan

- 단순 revert: 가능 — PR revert 1회. 엔진 코어 무접촉, CLI는 리팩터 전 동작과 동일 출력
- DB/외부 시스템: N/A

## Migration plan

N/A — breaking change 없음. OllamaClient.model 공개는 접근 완화(하위 호환), CLI 사용자 가시 동작 불변.

## 구현 세션 실행 방법

- 설계: Fable (본 세션) / 구현: **Haiku** (Phase당 1세션)

### 표준 구현 프롬프트

```
당신은 구현 전담 엔지니어입니다.

## 게이트 (최우선)
1. `cat docs/plans/web-phase-N.md` 를 실행하세요.
2. 파일이 없으면: "❌ Phase N 계획서가 없습니다." 출력 후 즉시 종료.
3. 파일에 `## Step 1` 섹션이 없으면: "❌ 계획서에 Step이 없습니다." 출력 후 즉시 종료.

## 규칙
- 계획서의 Code를 그대로 사용 — 자체 판단으로 코드를 작성하지 마세요
- Anchor 위치에 정확히 생성/삽입/교체
- "Do Not Touch" 목록을 건드리지 않음
- 각 Step의 Verify 실행 — 실패 시 해당 Step의 Code 재확인 (임의 변경 금지)
- 계획서에 없는 파일을 수정하지 않음

## 최종 게이트
1. Phase의 "최종 검증" 자동 검증 명령 실행, 결과 보고
2. Plan Fidelity Check:
   node "$HOME/.claude/plugins/cache/rtb-tools/rtb/1.3.90/skills/plan/scripts/check-plan-fidelity.js" \
     docs/plans/web-phase-N.md <이번 Phase에서 생성/수정한 모든 src 파일>
   exit 0=PASS / 1=누락 토큰 보완 / 스크립트 부재 시 최종 검증으로 갈음
```

## 4-6 자동화 검증 결과 (라운드 2)

- 라운드 1: 결정적 위반 1건 (검증 10 — Baseline 헤더 형식 미준수) → `main@17f680b (clean)` 형식으로 수정
- 라운드 2: **Hard gate PASS — 결정적 위반 0건, alert 0건**

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 수정 대상(ollama-client 1줄, cli/main.ts, package.json, CLAUDE.md)과 Do Not Touch(엔진 코어 4모듈, 기존 plan) 교집합 없음 (ollama-client는 Touch-Minimal로 1줄만 명시)
- 4-2 크로스 Phase 인터페이스: PASS — Phase 1 전제 = Phase 0 노출(App/createApp), Phase 2 전제 = Phase 1 노출(createChatServer) + API 계약 명세 일치
- 4-3 기술 제약 vs 코드: PASS — `.js` 확장자, `any` 0건, UI innerHTML 0건(Verify grep으로 강제), 테스트 FS `.test-tmp/`만
- 4-4 동반 변경 완전성: PASS — 새 가드(400/409/본문 상한/error 이벤트) → Phase 1 테스트 8케이스 / 리팩터 부산물(미사용 import) → 전체 교체본 반영 / 정적 파일 → build 복사 스텝 / serve 명령 → CLAUDE.md 갱신 지시

### 4-5/4-7

codex skip (동일 사유). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
