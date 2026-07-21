# Wiki OKF Foundation — Implementation Plan Index

Baseline: main@c4663c2 (clean)

## 개요

`openwiki/`를 canonical OKF v0.1 bundle로 추적하고 OpenWiki 0.2.1 cloud PR workflow 하나로 갱신한다.

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|---|---|---:|---|---|
| 0 | Canonical 계약과 workflow 단일화 | 8 | 없음 | ignore/workflow/instructions/sync/docs 계약 |
| 1 | OKF bundle 재생성 | generated | Phase 0 | OpenWiki 명령 실행과 required path gate |

## 실행 순서

Phase 0 → Phase 1. 병렬 실행 금지.

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|---|---|---:|---|
| Same File | `rg -n "openwiki/" .gitignore .github/workflows/openwiki-update.yml` | 2 | In-Scope |
| Adjacent Files | `rg -n "name: OpenWiki Update|OPENWIKI_PROVIDER|OPENWIKI_MODEL_ID" .github/workflows` | 2 workflow | In-Scope |
| Byproducts | `rg -n "sync-wiki|dev-wiki|OpenWiki" scripts package.json CLAUDE.md README.md docs/ROADMAP.md` | 10+ | In-Scope |

## File Touch Policy

| 분류 | 파일 | 정책 |
|---|---|---|
| **Do Not Touch** | `src/**`, `eval/**` | wiki foundation에서 runtime code 수정 금지 |
| **Touch-Minimal** | `AGENTS.md` | OpenWiki marker block만 tool이 관리 |
| **Full Scope** | `.gitignore`, `.github/workflows/openwiki*.yml`, `openwiki/**`, `scripts/sync-wiki.sh`, `CLAUDE.md`, `README.md`, `docs/ROADMAP.md` | canonical 계약 완결 |

## 형제 plan 교차

기존 `docs/plans/openwiki-index.md`는 완료된 과거 plan이다. 동시 landing 없음. 새 결정은 `knowledge-system-index.md`가 owner다.

## BE-FE 계약

SKIP — 문서 생성과 CI workflow만 변경한다.

## Rollback plan

Phase별 commit revert. `.last-update.json`은 계속 ignore한다.

## Migration plan

generated wiki source of truth가 sibling repo에서 in-repo bundle로 이동한다. `dev-wiki` sync는 optional mirror로 유지한다.

## 구현 세션 실행 방법

각 Phase에서 먼저 해당 문서를 읽고 `## Step 1` 존재를 확인한다. 문서의 Code와 Anchor만 적용하고, Do Not Touch 파일을 수정하지 않는다. 완료 후 각 Step Verify와 전체 gate를 실행한다.

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

- 추출된 term/카테고리: 16건
- 다른 정의로 중복 등장 (의심): 0건

### 검증 4: 임시 위치/전이 표시 (결정적)

- 임시 마커 매칭: 0건
  - (마커 없음 - plan 안에 임시 위치 후보가 없거나 표시 누락)

### 검증 5: 테스트 명세 누락 (결정적)

- 감지된 테스트 코드 블록: 0개
- 위반 (검증 대상 서브섹션 누락 또는 spy/branch/state 필드 누락): 0건
  - (테스트 코드 블록 없음 - 본 plan에 테스트 산출물 미포함)

### 검증 6: Step.Verify 다단계 표기 누락 (결정적)

- 감지된 Step Verify 섹션: 9개
- 위반 (3단계 주석 #1.빌드 / #2.테스트 / #3.의미 검증 누락): 0건

### 검증 7: Sweep Results 섹션 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (Sweep Results 헤딩 또는 3 차원 누락): 0건

### 검증 8: File Touch Policy 섹션 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (File Touch Policy 헤딩 또는 3 분류 누락): 0건

### 검증 9: Testability Review 섹션 누락 (결정적)

- Testability Review 발견 위치: docs/plans/wiki-okf-phase-0.md
- 위반 (헤딩 누락 또는 4 필드 누락): 0건

### 검증 10: Baseline 헤더 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (Baseline 헤더 누락 또는 dirty인데 전제 작업 누락): 0건

### 검증 11: 형제 plan 교차(1-3.G) / BE-FE 계약(1-3.H) sweep 누락 (결정적)

- 검증된 인덱스 파일: 1개
- 위반 (결과 또는 SKIP 사유 누락): 0건

### 검증 12: AC 명시 테스트 ↔ 테스트 산출물 (alert, LLM 검토 필요)

- 테스트를 명시한 AC/DoD 라인: 0건
- 테스트 산출물 신호: 없음
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
