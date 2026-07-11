# core-engine — Implementation Plan Index

Baseline: main@14c2a44 (clean)

## 개요

Qwen3 8B(로컬 Ollama) 대화형 챗봇 엔진의 Segment 1 — 스캐폴딩 + LLM 레이어 + 세션/CLI. 설계 문서: `docs/superpowers/specs/2026-07-11-chatbot-engine-design.md` (사용자 승인 완료).

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 프로젝트 스캐폴딩 | 7 | 없음 | package.json, tsconfig(×2), vitest, .gitignore, src/index.ts, CLAUDE.md |
| 1 | LLM 레이어 | 6 | Phase 0 | LlmClient 인터페이스, 에러 타입, ndjson 파서, OllamaClient + 테스트 2파일 |
| 2 | ChatSession + CLI | 3 | Phase 1 | 멀티턴 세션 + 테스트, REPL 엔트리 |

## 실행 순서

Phase 0 → Phase 1 → Phase 2 (순차 — 병렬 가능 Phase 없음).

## Segment 경계 (Out-of-Scope — 사용자 승인 완료)

- 컨텍스트 트리밍/요약/영속화 → Segment 2 (설계 Phase 2)
- RAG (청킹/임베딩/검색) → Segment 3. 전제: `ollama pull nomic-embed-text` (현재 미설치 확인)
- OpenWiki 연동, 웹 UI, LangChain 재구현 → Segment 4~6
- fake timer 기반 타임아웃 테스트 → Follow-up (Phase 0 Testability Review 참조)

## Sweep Results

기존 코드 0줄 (greenfield) — sweep은 "존재 코드 검색"이 아니라 "계획 코드 블록에 선제 적용"으로 수행. 실행 증거:

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `ls src/ 2>/dev/null` | 0 hits (디렉토리 없음 — 2026-07-11 실행) | — 해당 없음 (신규 레포) |
| Adjacent Files (인접 파일) | `ls -la` → `.git`, `docs`만 존재 | 0 hits | — 해당 없음 |
| Byproducts (부산물) | 도출 위험 카테고리 8종을 Phase 코드 블록에 선반영 | 8건 선반영 | In-Scope (8) — 아래 매핑 |

선반영 매핑: ①부분 라인 버퍼링→Phase1 Step3+Step5 경계 테스트 / ②스트림 에러 경로→finally+releaseLock / ③ECONNREFUSED→LlmConnectionError+AC3 / ④타임아웃→AbortController+clearTimeout×2 / ⑤`.js` 확장자→코드 예시 적용 규칙 / ⑥any 금지→unknown+타입 가드 / ⑦thinking 토큰→`think:false` 기본 / ⑧리소스 정리→reader.releaseLock+rl.close.

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `docs/superpowers/specs/**`, `.git/**` | 설계 문서와 git 내부 — 본 작업과 무관 |
| **Touch-Minimal** | — 해당 없음 | (기존 코드 없음) |
| **Full Scope** | `package.json`, `tsconfig*.json`, `vitest.config.ts`, `.gitignore`, `CLAUDE.md`, `src/**` | 전부 신규 생성 |

## 형제 plan 교차 (1-3.G)

SKIP — `docs/plans/`에 본 plan이 최초이며 동시 landing 형제 plan 없음, baseline clean.

## BE-FE 계약 경계 (1-3.H)

SKIP — 단일 프로세스 CLI로 BE-FE 경계/wire 직렬화 없음. (유일한 wire는 Ollama ndjson — Phase 1 Step 5 테스트가 직렬화 가정을 바이트 수준에서 검증.)

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | HTTP 청크가 라인/멀티바이트 경계에서 잘림 | M | M | 버퍼링 파서 + 바이트 분리 경계 테스트 (Phase 1 Step 5) |
| R2 | Ollama 미기동 시 불친절한 크래시 | M | L | LlmConnectionError + CLI 안내 후 exit 1 (AC3) |
| R3 | 장시간 대화 시 40K 컨텍스트 초과 | L | M | Out-of-Scope 명시 — Segment 2에서 트리밍 구현 |
| R4 | 구버전 Ollama가 `think` 필드 미지원 → `<think>` 토큰 노출 | L | L | 로컬 Ollama가 thinking capability 지원 확인됨. 노출되어도 기능 손상 없음 |

## Acceptance Criteria

- [ ] AC1: CLI 실행 → 입력 → qwen3:8b 응답이 토큰 단위 스트리밍 출력
- [ ] AC2: 멀티턴 — 직전 대화 참조 질문에 히스토리 반영 답변
- [ ] AC3: Ollama 미기동 시 연결 안내 오류 + exit code 1
- [ ] AC4: `npm test` 19 테스트 통과 — 정상/에러/경계(부분 ndjson, 멀티바이트 분리, 중간 실패) 포함, 실제 Ollama 불필요
- [ ] AC5: `/exit` 종료, `/clear` 히스토리 초기화

AC4는 Phase 1 Step 5~6 + Phase 2 Step 2 테스트 Step이 담당. AC1/2/3/5는 Phase 2 최종 검증의 수동 시나리오가 담당 (CLI 테스트 면제 사유는 Phase 2 Step 3 Context에 명시).

## Decision log + Alternatives considered

| 결정 | 선택 이유 | 검토했으나 안 한 대안 |
|------|----------|--------------------|
| Ollama native `/api/chat` (ndjson) | 스트리밍 파싱을 밑바닥에서 구현하는 것이 학습 목적 | `/v1/chat/completions` (OpenAI 호환 SSE) — Segment 6 LangChain 비교 소재로 보류 |
| `think: false` 기본 | thinking 토큰이 CLI UX 저해 + 응답 지연 | 항상 노출 — `ChatOptions.think`로 옵트인 지원 |
| 런타임 의존성 0개 | 설계 원칙 (fetch + Node 내장) | `ollama` npm 패키지 — 학습 목적 훼손 |
| 스트림 실패 시 히스토리 미기록 | 반쪽 응답이 이후 턴 컨텍스트 오염 방지 | 부분 기록 — 오염 위험으로 기각 |
| 테스트 위치 `src/**/__tests__/` | 사용자 전역 지침 기본값 (기존 패턴 없음) | colocated `*.test.ts` — 지침 기본값 우선 |
| `chat()`이 `chatStream()`을 소비 | 스트리밍이 단일 소스 — 로직 중복 제거 | 별도 non-stream 요청 — 중복 기각 |

## YAGNI 체크

- 추가 발견 추상화: provider 레지스트리/팩토리, retry+backoff, 설정 파일 로더, 로깅 프레임워크
- 사용자 결정: **N (전부 제외)** — LlmClient 인터페이스 1개가 승인된 추상화의 전부. 재시도는 로컬 단일 사용자에 불요, 설정은 env 2개(`OLLAMA_BASE_URL`, `OLLAMA_MODEL`)로 충분

## Rollback plan

- 단순 revert: 가능 — 전 파일 신규 생성, PR revert 1회로 복구
- DB/외부 시스템 변경: N/A

## Migration plan

N/A — breaking change 없음, 기존 호출자 없음 (greenfield).

## 구현 세션 실행 방법

- 설계(plan 작성): Fable (본 세션) / 구현(plan 실행): **Haiku** (계획서 코드를 그대로 적용)
- Phase당 1세션, Phase 문서 외 다른 파일 참조 불필요

### 표준 구현 프롬프트

```
당신은 구현 전담 엔지니어입니다.

## 게이트 (최우선)
1. `cat docs/plans/core-engine-phase-N.md` 를 실행하세요.
2. 파일이 없으면: "❌ Phase N 계획서가 없습니다." 출력 후 즉시 종료.
3. 파일에 `## Step 1` 섹션이 없으면: "❌ 계획서에 Step이 없습니다." 출력 후 즉시 종료.

## 규칙
- 계획서의 Code를 그대로 사용 — 자체 판단으로 코드를 작성하지 마세요
- Anchor 위치에 정확히 생성/삽입 (본 plan은 전부 새 파일)
- "Do Not Touch" 목록의 파일을 건드리지 않음
- 각 Step의 Verify를 실행하고 기대값 확인 — 실패 시 해당 Step의 Code 재확인
- 계획서에 없는 파일을 수정하지 않음

## 최종 게이트
Phase의 "최종 검증" 명령을 실행하고 결과(PASS/FAIL)를 보고.
Plan Fidelity Check (환경에 스크립트가 있는 경우):
  node "$HOME/.claude/plugins/cache/rtb-tools/rtb/1.3.90/skills/plan/scripts/check-plan-fidelity.js" \
    docs/plans/core-engine-phase-N.md <이번 Phase에서 생성한 모든 src 파일>
  exit 0=PASS / 1=누락 토큰 재구현 / 스크립트 부재 시 최종 검증 명령 결과로 갈음.
```

## 4-6 자동화 검증 결과 (라운드 2)

- 라운드 1: 결정적 위반 3건 (검증 5 — `### 검증 대상` 헤딩이 fence 직전 최근접 헤딩이 아님) → `### Code`와 fence 사이로 이동하여 수정
- 라운드 2: **결정적 위반 0건** (검증 1/1.B/4/5/6/7/8/9/10/11 전부 0), alert 2건

### alert 항목 LLM 검토 (수동)

- alert 1 (검증 3): `parseNdjsonStream`이 입출력 예제 표에 2행 등장 → **의도된 다중 예제** (정상 입력 행 + 에러 입력 행). 모순 아님.
- alert 2 (검증 3): `OllamaClient.chat`이 입출력 예제 표에 2행 등장 → **의도된 다중 예제** (정상 응답 행 + 연결 실패 행). 모순 아님.

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 모든 Step이 신규 파일 생성(create)이며 Do Not Touch 목록과 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 1 "전제 조건" = Phase 0 노출 인터페이스, Phase 2 "전제 조건" = Phase 1 노출 인터페이스 (시그니처 일치 확인)
- 4-3 기술 제약 vs 코드: PASS — 전 코드 블록 `.js` 확장자 import, `any` 0건, 런타임 의존성 0개
- 4-4 동반 변경 완전성: PASS — 새 throw(errors.ts) → 테스트 Step 5·6 존재 / 외부 devDeps → lock 파일 명시 / 새 추상화(ndjson, session) → 호출처 + 테스트 Step 동일 Phase 내 존재

### 4-5/4-7 (codex / plan 구조 리뷰)

사용자 승인으로 codex skip (개인 학습 프로젝트, 신규 레포). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
