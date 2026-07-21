# OKF Indexing and Freshness — Implementation Plan Index

Baseline: main@c4663c2 (clean)

## 개요

OKF frontmatter를 런타임 의존성 없이 파싱하고 metadata와 source fingerprint를 persisted index v2에 저장한다.

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|---|---|---:|---|---|
| 0 | OKF document parser | 2 | wiki-okf Phase 1 | parser/serializer와 unit tests |
| 1 | Metadata index v2와 freshness | 10 | Phase 0 | chunk/index/vector/app 계약과 tests |

## 실행 순서

Phase 0 → Phase 1.

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|---|---|---:|---|
| Same File | `rg -n "interface IndexedChunk|PersistedIndex|version: 1" src/rag/vector-index.ts` | 3 | In-Scope |
| Adjacent Files | `rg -n "VectorIndex.create|buildIndex|chunkMarkdown" src eval` | 20+ | In-Scope |
| Byproducts | `rg -n "VectorIndex.load|startupNotices|RAG 인덱스" src/app src/cli src/server` | 6 | In-Scope |

## File Touch Policy

| 분류 | 파일 | 정책 |
|---|---|---|
| **Do Not Touch** | `src/llm/**`, `src/native/**`, `src/server/public/**` | index contract와 무관 |
| **Touch-Minimal** | `src/app/bootstrap.ts` | load/rebuild freshness wiring만 수정 |
| **Full Scope** | `src/okf/**`, `src/rag/{chunker,indexer,vector-index}.ts`와 대응 tests | schema v2 완결 |

## 형제 plan 교차

`rag-trust`가 `IndexedChunk.metadata`와 `VectorIndex.search`를 소비한다. 이 plan이 생성/시그니처 owner이며 후행 plan은 제거하지 않는다.

## BE-FE 계약

SKIP — persisted local index와 App startup notice만 변경한다.

## Rollback plan

PR revert 후 v1 index code로 복구하고 `.chatbot/*.json`을 `/index`로 재생성한다.

## Migration plan

persisted index version 2는 version 1을 읽지 않는다. index는 파생 artifact이므로 data migration script 없이 재색인한다.

## 구현 세션 실행 방법

Phase 문서의 완전한 타입과 함수 코드를 적용한다. 각 Phase 마지막에 test/typecheck/build를 실행한다.

## 4-6 자동화 검증 결과 (라운드 3)

```text
## 4-6 자동화 검증 결과

자동 실행: `node plugins/rtb/skills/plan/scripts/check-doc-consistency.js <plan-files>`

### 검증 1: 섹션 번호/링크 유효 (결정적)

- 검증된 cross-reference: 0건
- 위반: 0건

### 검증 1.B: Markdown 상대 link 유효 (결정적)

- 검증된 상대 link: 0건
- 위반 (broken link): 0건

### 검증 2: 절대 규칙 vs 신규 규칙 충돌 (alert, LLM 검토 필요)

- 절대 규칙 keyword 매칭: 0건
- 부분 변경 패턴 매칭: 1건
- 충돌 의심 (+-20 line 내 인접): 0건

### 검증 3: 사실 일관성 (alert, LLM 검토 필요)

- 추출된 term/카테고리: 19건
- 다른 정의로 중복 등장 (의심): 0건

### 검증 4: 임시 위치/전이 표시 (결정적)

- 임시 마커 매칭: 0건
  - (마커 없음 - plan 안에 임시 위치 후보가 없거나 표시 누락)

### 검증 5: 테스트 명세 누락 (결정적)

- 감지된 테스트 코드 블록: 4개
- 위반 (검증 대상 서브섹션 누락 또는 spy/branch/state 필드 누락): 0건

### 검증 6: Step.Verify 다단계 표기 누락 (결정적)

- 감지된 Step Verify 섹션: 7개
- 위반 (3단계 주석 #1.빌드 / #2.테스트 / #3.의미 검증 누락): 0건

### 검증 7: Sweep Results 섹션 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (Sweep Results 헤딩 또는 3 차원 누락): 0건

### 검증 8: File Touch Policy 섹션 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (File Touch Policy 헤딩 또는 3 분류 누락): 0건

### 검증 9: Testability Review 섹션 누락 (결정적)

- Testability Review 발견 위치: docs/plans/okf-indexing-phase-0.md
- 위반 (헤딩 누락 또는 4 필드 누락): 0건

### 검증 10: Baseline 헤더 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (Baseline 헤더 누락 또는 dirty인데 전제 작업 누락): 0건

### 검증 11: 형제 plan 교차(1-3.G) / BE-FE 계약(1-3.H) sweep 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (결과 또는 SKIP 사유 누락): 0건

### 검증 12: AC 명시 테스트 ↔ 테스트 산출물 (alert, LLM 검토 필요)

- 테스트를 명시한 AC/DoD 라인: 0건
- 테스트 산출물 신호: 있음
- alert (AC가 테스트를 약속했는데 산출물 신호 없음): 0건

### 요약

- 결정적 위반 (검증 1 cross-reference): 0건
- 결정적 위반 (검증 1.B Markdown link): 0건
- 결정적 위반 (검증 4 임시 마커): 0건
- 결정적 위반 (검증 5 테스트 명세): 0건
- 결정적 위반 (검증 6 Verify 다단계): 0건
- 결정적 위반 (검증 7 Sweep Results): 0건
- 결정적 위반 (검증 8 File Touch Policy): 0건
- 결정적 위반 (검증 9 Testability Review): 0건
- 결정적 위반 (검증 10 Baseline 헤더): 0건
- 결정적 위반 (검증 11 형제 plan/BE-FE sweep): 0건
- alert (검증 2, 3, 12 LLM 검토 필요): 0건

**Hard gate**: PASS — 결정적 위반 0, alert 0
```

### 자동 수정 이력

- 라운드 1: 테스트 검증 대상, Testability 4필드, 예시 link 표기 누락을 보완했다.
- 라운드 2: Hard gate PASS 후 4-7 리뷰에서 실제 코드 계약·실패 복구·신뢰 gate 이슈를 발견해 계획을 재설계했다.
- 라운드 3: 리뷰 반영본 기준 결정적 위반 0건, alert 0건으로 Hard gate PASS.

### alert 항목 LLM 검토 (수동)

- 검증 2: 충돌 의심 0건 — 추가 조치 없음.
- 검증 3: 상충하는 중복 정의 0건 — 추가 조치 없음.
- 검증 12: 테스트 약속과 산출물 불일치 0건 — 추가 조치 없음.
