# memory — Implementation Plan Index

Baseline: main@1e36d80 (clean)

## 개요

Segment 2 — 컨텍스트 예산 관리(토큰 추정 + 쌍 단위 트리밍 + LLM 요약 압축)와 세션 영속화(JSON 자동 저장/복원). 설계 문서 `docs/superpowers/specs/2026-07-11-chatbot-engine-design.md`의 Phase 2에 해당. 압축 전략(트리밍+요약)과 영속화 방식(자동 저장/복원)은 사용자 승인 완료.

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 토큰 추정 + 트리밍 | 4 (신규) | 없음 | 순수 함수 — estimateTokens, trimToBudget + 테스트 11 |
| 1 | 요약 압축 + 세션 통합 | 5 (신규 3, 수정 2) | Phase 0 | summarizer, ContextManager, ChatSession 위임 + 테스트 8 |
| 2 | 세션 영속화 | 5 (신규 2, 수정 3) | Phase 1 | SessionStore(atomic write), restore, CLI 자동 저장/복원 + 테스트 7 |

## 실행 순서

Phase 0 → 1 → 2 (순차).

## Segment 경계 (Out-of-Scope — 사전 분석 보고에서 승인)

- Ollama 실측 토큰 수(`prompt_eval_count`) 활용 — `parseNdjsonStream` 인터페이스 변경 필요, 휴리스틱으로 충분해질 때까지 보류
- SQLite 영속화 — 외부 의존성 또는 Node 22 필요 (현재 Node 20). JSON으로 갈음
- 요약 재귀 압축(요약의 요약) — dropped 전체 재요약 방식으로 단순화 (트레이드오프는 Phase 1 Step 2 Context에 명시)
- 히스토리 메모리 무한 성장 — 개인 CLI 규모에서 무시 가능

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `grep -rn "getHistory\|this.history" src/ --include="*.ts"` (테스트 제외) | 6 hits — 전부 session.ts 내부 | In-Scope (1) — 히스토리 접근이 캡슐화되어 있어 트리밍을 session 내부에서만 처리 |
| Adjacent Files (인접 파일) | `grep -rn "new ChatSession" src/` | 6 hits — main.ts 1 + 테스트 5 | In-Scope (6) — 선택 필드 추가로 설계해 6곳 무수정 컴파일 (Phase 1 Step 4에서 회귀 테스트로 검증) |
| Byproducts (부산물) | `grep -n "eval_count" src/llm/ndjson.ts` | 0 hits — 실측 토큰 수는 파서가 미노출 | Out-of-Scope (1) — 휴리스틱 추정으로 결정, 사유 위 Segment 경계 참조 |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/llm/**` (Segment 1의 LLM 레이어), `docs/superpowers/specs/**`, `docs/plans/core-engine-*.md` | 본 Segment는 LLM 레이어 위에서만 동작 — 파서/클라이언트 무변경 |
| **Touch-Minimal** | `.gitignore` (2줄 추가), `CLAUDE.md` (1줄 추가), `src/chat/__tests__/session.test.ts` (케이스 추가만 — 기존 케이스 수정 금지) | 본 변경 외 기존 내용 재수정 금지 |
| **Full Scope** | `src/context/**` (신규), `src/store/**` (신규), `src/chat/session.ts`, `src/cli/main.ts` | 통상 품질 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — `docs/plans/core-engine-*.md`는 구현 완료·landing됨(`main@1e36d80`), 동시 landing 형제 없음. 공유 파일(session.ts, main.ts)은 landing된 코드 위의 순차 변경.

## BE-FE 계약 경계 (1-3.H)

SKIP — 단일 프로세스 CLI. 신규 wire는 세션 JSON 파일뿐이며 스키마 가드(`isPersistedSession`)와 손상 테스트가 Phase 2에서 검증.

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | 토큰 추정 오차로 실제 예산 초과 | M | M | 보수적 계수(non-ASCII 1자/토큰) + reserveTokens 1024 + SUMMARY_ALLOWANCE 예약 |
| R2 | 요약 LLM 호출 실패 | M | L | try/catch → 이전 캐시 재사용 또는 트리밍-only fallback (테스트 동반) — 대화 중단 없음 |
| R3 | 세션 파일 손상(쓰기 중 강제 종료) | L | M | atomic write(tmp→rename) + 손상 시 .bak 보존 후 새 세션 (테스트 동반) |
| R4 | 요약 품질 저하로 문맥 왜곡 | M | L | 요약 프롬프트에 "사실·선호·결정 우선 보존" 명시. 원본 히스토리는 메모리·파일에 보존되므로 손실 아님 |

## Acceptance Criteria

- [ ] AC1: 예산 초과 대화에서 오래된 내용이 요약 메시지로 압축되어 전송된다 (단위 테스트 — Phase 1 Step 3·5)
- [ ] AC2: CLI 재시작 시 이전 대화가 자동 복원되어 문맥이 이어진다 (수동 — Phase 2 최종 검증)
- [ ] AC3: `/clear` 후 재시작하면 빈 세션이다 (수동)
- [ ] AC4: 요약 호출 실패 시 크래시 없이 트리밍만으로 진행한다 (단위 테스트 — Phase 1 Step 3)
- [ ] AC5: 손상된 세션 파일이 있어도 .bak 보존 후 정상 시작한다 (단위 테스트 — Phase 2 Step 2)
- [ ] AC6: `npm test` 45 passed — 기존 19개 회귀 없음

## Decision log + Alternatives considered

| 결정 | 선택 이유 | 검토했으나 안 한 대안 |
|------|----------|--------------------|
| 휴리스틱 토큰 추정 (보수적) | 의존성 0 원칙. 과대 추정은 조기 압축일 뿐 오류 아님 | 실측 `prompt_eval_count` — 파서 인터페이스 변경 필요, Out-of-Scope |
| 기본 예산 4096 | Ollama 기본 `num_ctx`가 4096 — 모델 스펙(40K)이 아니라 서빙 현실에 맞춤 | 40960 기본 — 기본 서빙에서 조용한 잘림 발생 위험 |
| 쌍 단위 트리밍 | user/assistant 짝이 깨지면 모델이 문맥 오해 | 메시지 단위 — 짝 깨짐 위험으로 기각 |
| dropped 전체 재요약 + 개수 기준 캐시 | 구현 단순, 같은 범위 재요약 방지 | 증분 요약(요약+신규만 재요약) — 복잡도 대비 이득 작아 보류 |
| 전송 시점 압축, 원본 보존 | 히스토리 원본 무손실 — `/clear` 전까지 재구성 가능 | 히스토리 자체를 압축 — 원본 손실로 기각 |
| JSON + atomic write | 의존성 0, 사람이 읽을 수 있는 형식 | SQLite — 의존성/Node 22 필요 |
| 자동 저장/복원 (매 턴) | 사용자 무개입 연속성 (승인됨) | /save·/load 명령 — 명령 파싱 증가 |

## YAGNI 체크

- 추가 발견 추상화: 다중 세션 관리(세션 목록/전환), 요약 모델 분리 설정, 압축 전략 플러그인화, 저장 포맷 마이그레이션 프레임워크
- 사용자 결정: **N (전부 제외)** — `version: 1` 필드만 심어 후일 마이그레이션 여지를 남기고 그 외는 구현하지 않음

## Rollback plan

- 단순 revert: 가능 — PR revert 1회. 신규 모듈 2개 + 기존 파일 3개 수정(session.ts, main.ts, .gitignore)
- 사용자 데이터: `.chatbot/session.json`은 gitignore 대상 로컬 파일 — revert와 무관, 구버전 CLI도 무시하고 동작
- DB/외부 시스템: N/A

## Migration plan

N/A — breaking change 없음. `ChatSessionConfig`는 선택 필드 추가만, 기존 호출자 영향 없음 (Sweep Adjacent 6곳 무수정 검증).

## 구현 세션 실행 방법

- 설계: Fable (본 세션) / 구현: **Haiku** (Phase당 1세션)

### 표준 구현 프롬프트

```
당신은 구현 전담 엔지니어입니다.

## 게이트 (최우선)
1. `cat docs/plans/memory-phase-N.md` 를 실행하세요.
2. 파일이 없으면: "❌ Phase N 계획서가 없습니다." 출력 후 즉시 종료.
3. 파일에 `## Step 1` 섹션이 없으면: "❌ 계획서에 Step이 없습니다." 출력 후 즉시 종료.

## 규칙
- 계획서의 Code를 그대로 사용 — 자체 판단으로 코드를 작성하지 마세요
- Anchor 위치에 정확히 생성/삽입/교체 (수정 Step은 앵커 텍스트 유일성 확인)
- "Do Not Touch" 목록의 파일/코드를 건드리지 않음
- 각 Step의 Verify 실행 — 실패 시 해당 Step의 Code 재확인 (구현을 임의 변경 금지)
- 계획서에 없는 파일을 수정하지 않음

## 최종 게이트
1. Phase의 "최종 검증" 자동 검증 명령 실행, 결과 보고
2. Plan Fidelity Check:
   node "$HOME/.claude/plugins/cache/rtb-tools/rtb/1.3.90/skills/plan/scripts/check-plan-fidelity.js" \
     docs/plans/memory-phase-N.md <이번 Phase에서 생성/수정한 모든 src 파일>
   exit 0=PASS / 1=누락 토큰 보완 / 스크립트 부재 시 최종 검증으로 갈음
```

## 4-6 자동화 검증 결과 (라운드 1)

- **결정적 위반 0건** (검증 1/1.B/4/5/6/7/8/9/10/11 전부 0), alert 3건

### alert 항목 LLM 검토 (수동)

- alert 1 (검증 3): `estimateTokens` 입출력 예제 2행 → **의도된 다중 예제** (ASCII 행 + 한글 행). 모순 아님
- alert 2 (검증 3): `trimToBudget` 입출력 예제 2행 → **의도된 다중 예제** (부분 트리밍 행 + 전체 drop 행). 모순 아님
- alert 3 (검증 3): "시나리오" 컬럼명이 phase-1/phase-2 입출력 예제에 공용 → **의도된 표준 표 형식**. 모순 아님

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 수정 Step 대상(session.ts, main.ts, session.test.ts, .gitignore, CLAUDE.md)과 Do Not Touch(`src/llm/**`, specs, core-engine plans) 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 1 전제 = Phase 0 노출, Phase 2 전제 = Phase 1 노출 (시그니처 일치). ChatSession public 시그니처 불변 명시
- 4-3 기술 제약 vs 코드: PASS — `.js` 확장자, `any` 0건, 인덱스 접근은 `.at()`/옵셔널 체인, 테스트 FS는 `.test-tmp/`만
- 4-4 동반 변경 완전성: PASS — 새 상수(PER_MESSAGE_OVERHEAD, SUMMARY_ALLOWANCE) → 테스트가 src import / 새 가드(스키마 검증) → 손상 테스트 / 새 메서드(restore) → 테스트 / 산출 디렉토리(.chatbot, .test-tmp) → gitignore 등재 / 외부 호출(요약 LLM, 파일 IO) 실패 설계 각 Step Code에 명시

### 4-5/4-7

codex skip (Segment 1과 동일 사유 — 개인 학습 프로젝트). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
