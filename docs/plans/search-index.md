# search — Implementation Plan Index (Track A)

Baseline: main@55c937e (clean)

## 개요

Track A — 검색 품질 개선: **평가 세트로 측정 기반 확보 → BM25 밑바닥 구현 → RRF 하이브리드 검색**. 실측 근거는 두 가지 관찰 — 자기유사 코퍼스에서 정답 청크 top-4 탈락(Segment 3), nomic 임베딩의 유사도 판별력 한계(Segment 6). 코퍼스는 고정 스냅샷 fixture(사용자 승인).

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 평가 하네스 | 6 (신규 5, 수정 1묶음) | 없음 | corpus 동결, 골든 20문항, recall@K/MRR, `npm run eval` 벡터 베이스라인 + 테스트 6 |
| 1 | BM25 | 3 (신규 2, 수정 1) | Phase 0 | allChunks 접근자, BM25 밑바닥 + 테스트 8 |
| 2 | RRF 하이브리드 | 5 (신규 3, 수정 2) | Phase 0·1 | RRF 결합, HybridRetriever, bootstrap 교체, eval 비교 + 테스트 6 |

## 실행 순서

Phase 0 → 1 → 2 (순차). Phase 0의 eval 베이스라인이 Phase 2 개선 입증의 기준.

## Segment 경계 (Out-of-Scope — 승인)

- 재랭킹(cross-encoder/LLM rerank) — RRF 하이브리드 효과 측정 후 별도 (ROADMAP A 확장)
- 쿼리 변환(HyDE/multi-query) — 동일
- 골든 세트 확장(20→100) — 초기 20으로 신호 확인 후 필요 시
- 라이브 dev-wiki 평가 — 고정 fixture로 재현성 우선 (경계 결정)

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `grep -n "private readonly chunks\|get size" src/rag/vector-index.ts` | chunks private + size getter | In-Scope (1) — allChunks 읽기 접근자 추가 (Phase 1) |
| Adjacent Files (인접 파일) | `grep -rn "new Retriever" src/ (테스트 제외)` | 2 hits — bootstrap.ts | In-Scope (2) — HybridRetriever로 교체 (Phase 2 Step 3) |
| Byproducts (부산물) | vitest include=`src/**`, build outDir | eval/ 미수집·미제외 | In-Scope (2) — vitest include 확장 + build exclude (Phase 0 Step 6) |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/chat/**`, `src/context/**`, `src/store/**`, `src/llm/**`, `src/knowledge/**`, `src/cli/**`, `src/server/**`, 기존 plan | 검색 레이어 외 무변경 |
| **Touch-Minimal** | `src/rag/vector-index.ts` (접근자 1개), `src/app/bootstrap.ts` (Retriever→Hybrid 교체), `package.json`·`vitest.config.ts`·`tsconfig.build.json`·`CLAUDE.md` (각 1~2줄) | 본 변경 외 재수정 금지 |
| **Full Scope** | `eval/**` (신규), `src/rag/bm25.ts`·`fusion.ts`·`hybrid-retriever.ts` (신규) | 통상 품질 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan 전부 landing. 동시 landing 형제 없음.

## BE-FE 계약 경계 (1-3.H)

SKIP — 검색은 서버 내부 레이어. HybridRetriever는 기존 Retriever와 `retrieve(query): Promise<RetrievedContext>` 시그니처 동일(구조 호환)이라 wire 변화 없음. (웹 UI 출처 노출은 Track B, 본 plan 밖.)

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | 하이브리드가 벡터보다 나쁠 수 있음 | L | M | eval로 전후 비교 — 개선 없으면 파라미터(depth/RRF_K) 조정 또는 롤백. 측정이 곧 안전장치 |
| R2 | 골든 세트가 코퍼스에 편향 | M | L | source 단위 지표(청크 동일성 무관) + 20문항 분산 배치. 편향 발견 시 확장 |
| R3 | eval이 Ollama 필요 — CI 불가 | M | L | metric은 순수 함수로 단위 테스트, run은 수동. CI는 테스트만 |
| R4 | BM25 한국어 토큰화 조악(형태소 미분석) | M | L | 단어 런 기반 — 완벽하진 않지만 벡터 보완엔 충분. eval로 실측 |
| R5 | bootstrap 교체 회귀 | L | M | retrieve 시그니처 동일 + 기존 128 테스트 통과 게이트 |

## Acceptance Criteria

- [ ] AC1: `npm run eval` 벡터 베이스라인 출력 (Phase 0)
- [ ] AC2: BM25가 키워드 정확 매칭 문서를 상위 회수 (단위 테스트 — Phase 1)
- [ ] AC3: RRF가 양쪽 순위를 결합 (단위 테스트 — Phase 2)
- [ ] AC4: 하이브리드 recall@4/MRR ≥ 벡터 단독 (`npm run eval` 비교 — Phase 2)
- [ ] AC5: 챗봇 실동작 — 하이브리드로 교체 후 기존 대화/RAG 정상 (수동 스모크)
- [ ] AC6: `npm test` 134 passed — 기존 114 회귀 없음

## Decision log + Alternatives considered

| 결정 | 선택 이유 | 검토했으나 안 한 대안 |
|------|----------|--------------------|
| 고정 스냅샷 corpus | 재현성 — 개선 전후 점수가 항상 비교 가능 (승인) | 라이브 dev-wiki — wiki 변경 시 기준 오염 |
| source 단위 지표 (청크 아님) | 청킹 방식 바뀌어도 견고 | 청크 정확 동일성 — 재분할에 취약 |
| BM25 밑바닥 구현 | 의존성 0 유지 + TF-IDF 진화형 학습 가치 | `@langchain/community` BM25 — 의존성 |
| RRF 결합 (점수 아닌 순위) | 코사인 vs BM25 스케일 차이를 정규화 없이 안전 결합 (표준) | 점수 가중합 — 스케일 정규화 튜닝 필요 |
| HybridRetriever 별도 클래스 | 기존 Retriever는 eval 벡터 단독 비교용 보존 | Retriever 확장 — 벡터 단독 경로 소실 |
| eval run은 수동(테스트 아님) | 실제 임베딩 필요 — CI 분리 | 임베딩 mock eval — 실측 신호 소실 |

## YAGNI 체크

- 추가 발견 추상화: 검색기 플러그인 레지스트리, 가중치 설정 UI, 재랭킹 단계, 쿼리 확장
- 사용자 결정: **N (전부 제외)** — HybridConfig(topK/depth)만 노출. 재랭킹은 eval로 하이브리드 효과 확인 후 별도 판단

## Rollback plan

- 단순 revert: 가능 — PR revert 1회. bootstrap을 Retriever로 되돌리면 벡터 단독 복귀 (eval/, bm25/fusion/hybrid는 무해한 미사용 모듈로 남거나 함께 revert)
- DB/외부 시스템: N/A

## Migration plan

N/A — breaking change 없음. HybridRetriever는 Retriever와 구조 호환, 기존 인덱스 파일 포맷 불변.

## 구현 세션 실행 방법

- 설계: Fable (본 세션) / 구현: **Haiku** (Phase당 1세션)

### 표준 구현 프롬프트

```
당신은 구현 전담 엔지니어입니다.

## 게이트 (최우선)
1. `cat docs/plans/search-phase-N.md` 를 실행하세요.
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
     docs/plans/search-phase-N.md <이번 Phase에서 생성/수정한 모든 src·eval 파일>
   exit 0=PASS / 1=누락 토큰 보완 / 스크립트 부재 시 최종 검증으로 갈음
```

## eval 결과

- **벡터 베이스라인 (Phase 0, 2026-07-13)**: `[vector] n=20 recall@1=0.450 recall@4=0.850 MRR=0.618`
  - Phase 0 구현 중 결함 발견·수정: 청크 source가 전체 경로인데 golden expectedSource는 파일명이라 매칭 0 → run.ts에 `toSourceName`(basename 정규화) 추가. 엔진 indexer는 경로 유지(정상).
- **하이브리드 (Phase 2, 2026-07-13)**: `[hybrid] n=20 recall@1=0.650 recall@4=0.950 MRR=0.795`

| 지표 | 벡터 단독 | 하이브리드(RRF) | 개선 |
|------|----------|----------------|------|
| recall@1 | 0.450 | **0.650** | +0.200 |
| recall@4 | 0.850 | **0.950** | +0.100 |
| MRR | 0.618 | **0.795** | +0.177 |

AC4 충족 — 하이브리드가 전 지표에서 벡터 단독을 상회. 독립 재실행에서 동일 수치 재현. 챗봇 실동작(하이브리드 교체 후 RAG 정상) 스모크 통과.

## 4-6 자동화 검증 결과 (라운드 1)

- **결정적 위반 0건**, alert 2건 (첫 라운드 통과)

### alert 항목 LLM 검토 (수동)

- alert 1~2 (검증 3): `npm run eval`/`Bm25Index.search`가 입출력 예제 표에 2행 등장 → **의도된 다중 예제** (정상/경계 분리). 모순 아님

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 수정 대상(vector-index 접근자, bootstrap, 설정 3파일, CLAUDE.md)과 Do Not Touch(검색 외 레이어, 기존 plan) 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 1 전제 = Phase 0 노출(SearchFn/runEval), Phase 2 전제 = Phase 0·1 노출(Bm25Index/allChunks). 시그니처 일치
- 4-3 기술 제약 vs 코드: PASS — `.js` 확장자, `any` 0건, 런타임 의존성 0(BM25 밑바닥), Map/배열 `?? 0`/`.at()` 가드
- 4-4 동반 변경 완전성: PASS — 새 상수(RRF_K, GOLDEN_QUESTIONS) → 테스트 src import / 새 접근자(allChunks) → 소비자+테스트 / bootstrap 교체(retrieve 시그니처 동일) → 기존 테스트 회귀 게이트 / eval 산출 → vitest include·build exclude 동반
- 안전장치 특기: R1(하이브리드가 더 나쁠 위험)은 eval 측정 자체가 완화 — AC4가 수치 게이트

### 4-5/4-7

codex skip (개인 학습 프로젝트). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
