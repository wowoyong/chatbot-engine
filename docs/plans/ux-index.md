# ux — Implementation Plan Index (Track B + 마크다운)

Baseline: main@08ac639 (clean)

## 개요

Track B 퀵윈(출처 표시·응답 중단·실측 토큰) + Track E 마크다운 렌더링. 핵심 설계: 스트리밍 generator가 content를 yield하고 완료 시 메타(출처·토큰)를 return — OpenAI usage 스트림과 동형, `for await` 기존 코드 무변경.

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 메타 채널 | 6 (수정 3, 신규 2, +bootstrap 확인) | 없음 | 파서 stats + chatStream/session return TurnMeta + 테스트 4 |
| 1 | 서버 SSE + CLI | 3 (수정) | Phase 0 | sources/usage SSE 이벤트, CLI 출처·토큰 푸터, 중단 감지 + 테스트 |
| 2 | 웹 UI | 1 (수정) | Phase 1 | 출처 접이식, 토큰 표시, 중단 버튼(AbortController), 마크다운 렌더(안전) |

## 실행 순서

Phase 0 → 1 → 2 (순차).

## Segment 경계 (Out-of-Scope)

- 실측 토큰 그래프/누적 통계 — 단일 턴 표시로 충분
- 마크다운 전 CommonMark 지원 — 코드블록·목록·강조·링크만 (경량 렌더러)
- SSE 재연결 — 단일 사용자 로컬

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `grep -n "AsyncGenerator<string>" src/llm/*.ts src/chat/*.ts` | 파서/client/session 3곳 | In-Scope (3) — return 타입 확장 (Phase 0) |
| Adjacent Files (인접 파일) | `grep -n "for await.*send\|res.write.*piece" src/cli src/server` | CLI·서버 소비처 | In-Scope (2) — 수동 iterate로 메타 포착 (Phase 1) |
| Byproducts (부산물) | bootstrap retriever 래퍼가 hits 통과? | HybridRetriever는 hits 반환 — optional로 자동 흐름 | 확인 (0) — ContextRetriever.hits optional이라 무변경 |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/rag/**`, `src/context/**`, `src/store/**`, `src/knowledge/**`, `eval/**`, 기존 plan | UX 외 레이어 무변경 |
| **Touch-Minimal** | `src/app/bootstrap.ts`(무변경 예상 — 확인만) | hits optional 흐름 확인 |
| **Full Scope** | `src/llm/ndjson.ts`·`ollama-client.ts`, `src/chat/session.ts`, `src/cli/main.ts`, `src/server/http-server.ts`, `src/server/public/index.html` | 통상 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan 전부 landing.

## BE-FE 계약 경계 (1-3.H)

활성 — SSE wire 확장: 기존 `data:{piece}`/`event:done`/`event:error`에 **`event:sources data:{sources:[{source,heading}]}`** (content 전, 있을 때만) + done의 `data`에 `{promptTokens,responseTokens}` 추가. UI 파서(handleFrame)가 새 이벤트 처리. 서버 테스트가 프레임 형식 고정.

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | generator return이 기존 for-await 소비를 깨뜨림 | L | H | return은 for-await가 무시 — 기존 133 테스트가 회귀 게이트 |
| R2 | 마크다운 렌더 XSS | M | M | 경량 렌더러가 텍스트를 escape 후 화이트리스트 태그만 생성 (innerHTML 최소·검증) |
| R3 | 구버전 Ollama가 eval_count 미제공 | L | L | optional — 없으면 토큰 미표시 |
| R4 | 중단 시 부분 히스토리 | L | L | 기존 "완주 시에만 기록" 원칙 재사용 |

## Acceptance Criteria

- [ ] AC1: 파서/세션이 토큰 통계·출처를 return (단위 — Phase 0)
- [ ] AC2: 서버 SSE가 sources 이벤트 + done usage 전송 (단위 — Phase 1)
- [ ] AC3: 웹 UI에 출처·토큰 표시, 중단 버튼 동작 (수동 — Phase 2)
- [ ] AC4: 봇 답변 마크다운 렌더 + XSS 안전 (수동 + grep — Phase 2)
- [ ] AC5: `npm test` 회귀 없음 (기존 133 유지·증가)

## Decision log

| 결정 | 이유 | 대안 |
|------|------|------|
| generator return으로 메타 전달 | for-await 무변경 + OpenAI usage 스트림 동형 | 유니온 yield — 전 소비자 breaking |
| 경량 마크다운 렌더 자작 | 의존성 0 유지 | marked/markdown-it — 의존성 |
| sources를 별도 SSE 이벤트 | content 전 즉시 표시 | done에 합침 — 스트림 끝까지 대기 |

## YAGNI 체크

- 추가 발견: 토큰 누적 대시보드, 마크다운 테이블/각주, 출처 클릭→원문
- 결정: **N** — 단일 턴 표시 + 기본 마크다운만

## Rollback plan

PR revert 1회. generator return은 하위 호환이라 부분 revert도 안전.

## Migration plan

N/A — breaking 없음 (return 무시로 기존 소비 유지).

## 구현 세션 실행 방법

- 설계: Fable / 구현: Haiku (Phase당 1세션). 표준 구현 프롬프트는 core-engine-index.md와 동일.

## 4-6 자동화 검증 결과

(스크립트 실행 후 첨부)
