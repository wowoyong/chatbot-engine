# capture — Implementation Plan Index

Baseline: main@753ba77 (clean)
구현 완료: `main@bc67582` (Phase 0: a3a830f / Phase 1: 26babd8 / Phase 2: bc67582 — 테스트 114 passed, 실기 AC: 저장→멱등 스킵→RAG 회상 루프 검증)

## 개요

Segment 5.5 — knowledge-capture: 대화에서 재사용 가치가 있는 지식을 추출하고, **기존 지식베이스에 없는 것만**(novelty 판정) 분류·저장 후 자동 재인덱싱하는 자기참조 루프. 트리거(명시적 `/capture`)와 범위(현재 세션 전체)는 사용자 승인 완료.

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 추출기 + novelty | 4 (신규) | 없음 | JSON 강건 파싱 추출기, 유사도 기반 신규 판정 + 테스트 11 |
| 1 | 저장소 + App 통합 | 4 (신규 3, 수정 1) | Phase 0 | 슬러그 저장소, bootstrap에 currentIndex·captureKnowledge + 테스트 9 |
| 2 | 인터페이스 연결 | 4 (수정) | Phase 1 | CLI `/capture`, `POST /api/capture`, 웹 버튼 + 테스트 2 |

## 실행 순서

Phase 0 → 1 → 2 (순차).

## Segment 경계 (Out-of-Scope — 사전 분석 보고에서 승인)

- 매 턴 자동 캡처 — 8B 추출 품질 검증 후 후속 (명시적 트리거 승인)
- captured 문서의 수동 큐레이션 워크플로우 (dev-wiki 이동/정리) — 파일이 md라 수동 편집으로 충분
- threshold 자동 튜닝 — 저장 파일의 novelty 점수 기록으로 관찰 데이터부터 축적
- 추출 재시도/자가 수정 루프 — 실패 시 사용자 재시도 안내로 갈음

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `grep -n "let retriever" src/app/bootstrap.ts` | 1 hit (L61) — VectorIndex 원본 미보관 | In-Scope (1) — `currentIndex` 추가 + rebuild 내부 함수 승격 (Phase 1 Step 3) |
| Adjacent Files (인접 파일) | CLI dispatch 3곳 / 서버 라우트 5곳 / UI 버튼 핸들러 3곳 grep | 각 패턴 확인 | In-Scope (3) — 세 인터페이스에 동일 패턴으로 연결 (Phase 2), App 메서드 하나로 로직 단일화 |
| Byproducts (부산물) | 저장 위치가 RAG 소스 밖이면 novelty 루프 미완결 | 설계 결정 1건 | In-Scope (1) — `<docsDir>/captured` 고정 + 저장 시 재인덱싱 (Phase 1) |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/chat/**`, `src/context/**`, `src/rag/**`, `src/store/**`, `src/llm/**`, 기존 plan 문서 | 엔진 코어 무변경 |
| **Touch-Minimal** | `src/cli/main.ts` (명령 1블록+배너), `src/server/http-server.ts` (라우트 1블록), `src/server/public/index.html` (버튼+핸들러), `src/server/__tests__/http-server.test.ts` (Fake chat 필드화+케이스 추가), `CLAUDE.md` (1줄) | 본 변경 외 재수정 금지 |
| **Full Scope** | `src/knowledge/**` (신규), `src/app/bootstrap.ts` (전체 교체 — captureKnowledge 추가) | 통상 품질 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan 전부 landing. 동시 landing 형제 없음.

## BE-FE 계약 경계 (1-3.H)

활성 — 신규 wire 1건: `POST /api/capture` → `CaptureResult` JSON `{extracted: number, saved: string[], skipped: string[]}` — 타입은 bootstrap 단일 소스, UI는 세 필드만 소비(문자열 합성 렌더), 실패는 기존 outer catch의 500 JSON 규약 재사용. 서버 테스트(Phase 2 Step 3)가 응답 형태 고정.

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | 8B의 JSON 추출 불량 (코드펜스/부가 텍스트/불량 항목) | H | M | 관대한 파서(첫`[`~끝`]`) + 항목 단위 가드 드롭 + 실패 시 대화 무영향 재시도 안내 (테스트 동반) |
| R2 | novelty 임계값 0.75 오판 | M | M | 저장 파일에 최고 유사도 기록 — 관찰 후 조정 (judgeNovelty threshold 인자) |
| R3 | 인덱스 없는 상태의 capture | L | L | 정의상 전부 신규 — 명시 분기 + 테스트 |
| R4 | capture 중 채팅 요청 경합 | L | L | capture는 세션 히스토리를 읽기만 함 — 쓰기 경합 없음. Ollama 요청은 서버가 큐잉 |
| R5 | 같은 지식 반복 저장 | M | L | 저장 즉시 재인덱싱 → 다음 capture의 novelty 기준에 포함 (자기참조 루프) |

## Acceptance Criteria

- [ ] AC1: 새 지식이 담긴 대화에서 `/capture` → `<RAG소스>/captured/<분류>/` 저장 + 결과 요약 출력 (수동 + 통합 테스트)
- [ ] AC2: 같은 대화로 다시 `/capture` → 저장 0건, 스킵 보고 — 멱등 (수동 + 단위 테스트)
- [ ] AC3: 추출 불량 시 대화 중단 없이 오류 안내 (단위 테스트 — CLI/서버 각각)
- [ ] AC4: 저장 직후 챗봇이 그 지식을 검색 활용 (재인덱싱 — 통합 테스트의 인덱스 갱신 확인 + 수동)
- [ ] AC5: 웹 버튼과 CLI가 같은 결과 (App 메서드 단일 소스 — 라우트 테스트)
- [ ] AC6: `npm test` 114 passed — 기존 92 회귀 없음

## Decision log + Alternatives considered

| 결정 | 선택 이유 | 검토했으나 안 한 대안 |
|------|----------|--------------------|
| 명시적 `/capture` 트리거 | 8B 이중 호출 비용 통제 + 추출 품질 관찰 (승인됨) | 매 턴 자동 — 품질 미검증 상태에서 쓰레기 누적 위험 |
| novelty = 기존 인덱스 최고 유사도 < 0.75 | 이미 있는 검색 인프라 재사용, 점수 기록으로 튜닝 가능 | LLM에게 "이미 아는지" 질의 — 비용↑ + 환각 위험 |
| 추출·분류를 한 번의 LLM 호출로 | 호출 수 최소화 — category를 추출 스키마에 포함 | 별도 분류 호출 — 비용 2배 |
| 저장 위치 `<docsDir>/captured` 고정 | 저장 즉시 RAG 소스 — 재인덱싱만으로 novelty 루프 완결 | 별도 디렉토리 — 인덱스 밖이라 중복 저장 루프 발생 |
| 관대한 JSON 파서 + 항목 드롭 | 8B 출력 현실 대응 — 부분 성공 허용 | 엄격 파싱 — 사소한 형식 이탈로 전체 실패 |
| 잘못된 category → concept 정규화 | 가장 포괄적 분류로 수용 — 데이터 유실 방지 | 해당 항목 드롭 — 분류 오류로 지식 유실 |
| 오케스트레이션을 App 메서드로 | CLI·웹 동시 적용 (Segment 5 bootstrap의 가치 실증) | 인터페이스별 구현 — 중복 |

## YAGNI 체크

- 추가 발견 추상화: capture 이력 로그 파일, 카테고리 사용자 정의, 지식 편집/삭제 API, 요약 기반 지식 병합
- 사용자 결정: **N (전부 제외)** — 저장물이 평문 md라 편집·삭제는 파일 조작으로 충분

## Rollback plan

- 단순 revert: 가능 — PR revert 1회. captured/ 산출물은 RAG 소스 디렉토리의 일반 md — revert 후에도 무해(원치 않으면 디렉토리 삭제 + 재인덱싱)
- DB/외부 시스템: N/A

## Migration plan

N/A — breaking change 없음. App 인터페이스는 메서드 추가만, 기존 라우트·명령 불변.

## 구현 세션 실행 방법

- 설계: Fable (본 세션) / 구현: **Haiku** (Phase당 1세션)

### 표준 구현 프롬프트

```
당신은 구현 전담 엔지니어입니다.

## 게이트 (최우선)
1. `cat docs/plans/capture-phase-N.md` 를 실행하세요.
2. 파일이 없으면: "❌ Phase N 계획서가 없습니다." 출력 후 즉시 종료.
3. 파일에 `## Step 1` 섹션이 없으면: "❌ 계획서에 Step이 없습니다." 출력 후 즉시 종료.

## 규칙
- 계획서의 Code를 그대로 사용 — 자체 판단으로 코드를 작성하지 마세요
- Anchor 위치에 정확히 생성/삽입/교체 (수정 Step은 앵커 텍스트 유일성 확인)
- "Do Not Touch" 목록을 건드리지 않음
- 각 Step의 Verify 실행 — 실패 시 해당 Step의 Code 재확인 (임의 변경 금지)
- 계획서에 없는 파일을 수정하지 않음

## 최종 게이트
1. Phase의 "최종 검증" 자동 검증 명령 실행, 결과 보고
2. Plan Fidelity Check:
   node <계획 도구>/check-plan-fidelity.js \
     docs/plans/capture-phase-N.md <이번 Phase에서 생성/수정한 모든 src 파일>
   exit 0=PASS / 1=누락 토큰 보완 / 스크립트 부재 시 최종 검증으로 갈음
```

## 4-6 자동화 검증 결과 (라운드 1)

- **결정적 위반 0건**, alert 2건 (첫 라운드 통과)

### alert 항목 LLM 검토 (수동)

- alert 1~2 (검증 3): `parseCandidates`/`judgeNovelty`가 입출력 예제 표에 2행 등장 → **의도된 다중 예제** (정상/에러·경계 행 분리). 모순 아님

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 수정 대상(bootstrap, cli, http-server, index.html, 서버 테스트, CLAUDE.md)과 Do Not Touch(엔진 코어 5모듈, 기존 plan) 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 1 전제 = Phase 0 노출(extractKnowledge/judgeNovelty), Phase 2 전제 = Phase 1 노출(CaptureResult/captureKnowledge). 시그니처 일치
- 4-3 기술 제약 vs 코드: PASS — `.js` 확장자, `any` 0건, UI textContent만, 테스트 FS `.test-tmp/`만
- 4-4 동반 변경 완전성: PASS — 새 상수(KNOWLEDGE_CATEGORIES, DEFAULT_NOVELTY_THRESHOLD) → 테스트 src import / 새 가드(파싱 throw, 불량 드롭) → 경로 테스트 / 새 메서드(captureKnowledge) → 통합 테스트 + 세 인터페이스 연결 + 라우트 테스트 / Fake chat 필드화 → 기본값 유지로 기존 케이스 무영향

### 4-5/4-7

codex skip (동일 사유). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
