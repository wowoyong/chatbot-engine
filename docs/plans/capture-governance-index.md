# Capture Governance — Implementation Plan Index

Baseline: main@c4663c2 (clean)

## 개요

대화 추출 결과를 OKF draft로 저장하고 명시적 승인 후 verified로 전환하여 chat retrieval에 노출한다.

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|---|---|---:|---|---|
| 0 | Captured lifecycle store | 2 | rag-trust Phase 1 | draft 저장, list, approve와 traversal guard |
| 1 | App/API/CLI/Web orchestration | 10 | Phase 0 | mutation queue, 승인 endpoint와 review UX |

## 실행 순서

Phase 0 → Phase 1.

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|---|---|---:|---|
| Same File | `rg -n "saveCaptured|listCaptured|writeFileAtomic|join\(" src/knowledge/capture-store.ts` | 8+ | In-Scope |
| Adjacent Files | `rg -n "captureKnowledge|/capture|/captured|api/captured" src/app src/cli src/server` | 20+ | In-Scope |
| Byproducts | `rg -n "rebuildIndex|writeFileAtomic|chatting" src/app src/server` | serialization 0 | In-Scope: mutation queue |

## File Touch Policy

| 분류 | 파일 | 정책 |
|---|---|---|
| **Do Not Touch** | `src/llm/**`, `src/native/**`, `.github/**` | capture lifecycle 밖 |
| **Touch-Minimal** | `src/app/bootstrap.ts`, `src/cli/main.ts`, `src/server/http-server.ts`, `src/server/public/index.html` | 승인 lifecycle wiring만 수정 |
| **Full Scope** | `src/knowledge/capture-store.ts`, `src/app/mutation-queue.ts`, 대응 tests | lifecycle와 concurrency 완결 |

## 형제 plan 교차

`rag-trust`가 확정한 sources UI와 SSE를 보존한다. `knowledge-quality`는 capture API를 수정하지 않고 평가/문서만 소비한다.

## BE-FE 계약

활성: `GET /api/captured` item에 `id,status`를 추가하고 `POST /api/captured/approve`를 추가한다. 승인 응답은 `{entry,indexUpdated,warning?}`이며 같은 Phase에서 CLI/browser consumer와 HTTP tests를 갱신한다.

## Rollback plan

Phase 1 revert로 approve surface 제거, Phase 0 revert로 legacy 즉시 searchable capture 복구.

## Migration plan

frontmatter 없는 legacy captured Markdown은 `verified`로 간주한다. 신규 capture만 `draft`다.

## 구현 세션 실행 방법

path validation과 queue error recovery tests를 먼저 적용한 후 app/server/UI를 연결한다.

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
- 부분 변경 패턴 매칭: 0건
- 충돌 의심 (+-20 line 내 인접): 0건

### 검증 3: 사실 일관성 (alert, LLM 검토 필요)

- 추출된 term/카테고리: 18건
- 다른 정의로 중복 등장 (의심): 0건

### 검증 4: 임시 위치/전이 표시 (결정적)

- 임시 마커 매칭: 0건
  - (마커 없음 - plan 안에 임시 위치 후보가 없거나 표시 누락)

### 검증 5: 테스트 명세 누락 (결정적)

- 감지된 테스트 코드 블록: 6개
- 위반 (검증 대상 서브섹션 누락 또는 spy/branch/state 필드 누락): 0건

### 검증 6: Step.Verify 다단계 표기 누락 (결정적)

- 감지된 Step Verify 섹션: 8개
- 위반 (3단계 주석 #1.빌드 / #2.테스트 / #3.의미 검증 누락): 0건

### 검증 7: Sweep Results 섹션 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (Sweep Results 헤딩 또는 3 차원 누락): 0건

### 검증 8: File Touch Policy 섹션 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (File Touch Policy 헤딩 또는 3 분류 누락): 0건

### 검증 9: Testability Review 섹션 누락 (결정적)

- Testability Review 발견 위치: docs/plans/capture-governance-phase-0.md
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
