# gguf — Implementation Plan Index (Segment 1: GGUF 로더)

Baseline: main@4618368 (clean)
구현 완료: `main@c486e1d` (Phase 0·1 — 테스트 157, 실파일 통합 AC3/AC4 통과)

## 개요

자체 LLM 추론 엔진의 첫 조각 — GGUF(F16) 파일을 파싱해 하이퍼파라미터 + 가중치 텐서(F16→F32 dequant)를 노출하는 순수 TS 로더. 설계 문서: `docs/design/2026-07-13-native-llm-inference-design.md`. 대상: Qwen2.5-0.5B-Instruct-fp16 (실측: 290 텐서, F16 169 + F32 121, alignment 32).

## 실측 확정값 (계획 시점 GGUF 파싱)

- 아키텍처 qwen2, 24층, hidden 896, FFN 4864, head 14 / KV head 2 (head_dim 64), RoPE θ 1e6, RMS eps ~1e-6, vocab 151936
- 텐서 타입: F16(1) = 가중치, F32(0) = norm/bias. K-quant 없음 → dequant은 F16→F32 + F32 passthrough만
- alignment 32 (텐서 데이터 오프셋 정렬)

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 바이너리 리더 + GGUF 파서 | 4 (신규) | 없음 | ByteReader(LE 프리미티브), 헤더·메타데이터 KV(13 타입)·텐서 info 파싱 + 테스트 |
| 1 | F16 dequant + GgufModel | 4 (신규) | Phase 0 | f16→f32, 하이퍼파라미터 추출, 텐서 lazy 로드 + 단위·통합 테스트 |

## 실행 순서

Phase 0 → 1 (순차).

## Segment 경계 (Out-of-Scope — 후속 Segment)

- BPE 토크나이저 → Segment 2 (GGUF 메타의 tokens/merges 소비)
- 트랜스포머 forward → Segment 3
- 샘플링 + LlmClient 어댑터 → Segment 4
- K-quant(Q4_K 등) dequant → 미지원 (F16만, 설계 결정)
- mmap/스트리밍 로드 → 전체 Buffer 로드로 갈음 (F16 ~1GB, 16GB에서 허용)

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `ls src/gguf 2>/dev/null` | 0 (신규 디렉토리) | — 해당 없음 |
| Adjacent Files (인접 파일) | `grep -rln "readUInt32LE\|DataView\|f16\|GGUF" src/` | 0 hits — 바이너리 파싱 기존 없음 | — 해당 없음 (신규 영역) |
| Byproducts (부산물) | 위험 카테고리 선반영: 버퍼 경계 초과, F16 subnormal/inf/nan, 큰 배열(vocab 151k) 메모리, 오프셋 정렬 오류 | 4건 선반영 | In-Scope (4) — 코드 블록에 가드 포함 |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/llm/**`, `src/chat/**`, `src/rag/**`, `src/context/**`, `src/store/**`, `src/knowledge/**`, `src/server/**`, `src/cli/**`, 기존 plan | 추론 엔진은 상위 무변경 (Segment 4에서만 LlmClient 어댑터 추가) |
| **Touch-Minimal** | — 해당 없음 | (신규 모듈만) |
| **Full Scope** | `src/gguf/**` (신규) | 통상 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan 전부 landing. 동시 landing 형제 없음.

## BE-FE 계약 경계 (1-3.H)

SKIP — 파일 파싱 순수 로직, wire 없음. (GGUF 바이너리 포맷은 외부 계약이나 read-only 소비 — Phase 1 테스트가 실제 파일로 검증.)

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | 버퍼 경계 초과 read (vocab 151k 배열) | M | M | 리더가 남은 바이트 검사 후 read, 부족 시 throw (Phase 0 가드 + 테스트) |
| R2 | F16 dequant 부정확 (subnormal/inf/nan) | M | H | IEEE754 half 규격대로 구현 + 알려진 값(0,1,-2,inf,nan) 단위 테스트 |
| R3 | 텐서 데이터 오프셋 정렬(align 32) 오류 | M | H | 정렬 계산 명시 + 실제 파일 텐서 첫 값 교차 검증 |
| R4 | 전체 파일 Buffer 로드 메모리(~1GB) | L | M | F16만 (Q4 아님) — 1GB, 16GB에서 허용. 텐서 dequant는 요청 시(lazy) |
| R5 | metadata 배열 타입 재귀 파싱 누락 | L | M | 13 GGUF 타입 전부 구현 (array 재귀 포함) + 테스트 |

## Acceptance Criteria

- [ ] AC1: 크래프트한 최소 GGUF 버퍼에서 헤더·메타데이터·텐서 info를 정확히 파싱 (단위)
- [ ] AC2: f16ToF32가 알려진 값(0/1/-2/0.5/inf/nan/subnormal)을 정확히 변환 (단위)
- [ ] AC3: 실제 qwen2.5-0.5b-fp16 파일에서 하이퍼파라미터(24층/896/head 14·2 등) 추출 (통합)
- [ ] AC4: token_embd 텐서 dequant 후 shape [151936,896] + 유한값 (통합)
- [ ] AC5: 버퍼 초과·미지원 타입 시 throw (단위)
- [ ] AC6: `npm test` 회귀 없음 (기존 144 유지·증가)

## Decision log

| 결정 | 이유 | 대안 |
|------|------|------|
| F16 GGUF만 지원 | dequant 단순(비트 변환) — K-quant는 수십 포맷 | Q4_K 지원 — 학습 목적 대비 과복잡 |
| 전체 Buffer 로드 | 코드 단순, 1GB 허용 | mmap/스트리밍 — 복잡, 속도 무관(교육) |
| 텐서 lazy dequant | 필요 텐서만 F32화 — 메모리 절감 | 전량 선-dequant — 2GB+ 상주 |
| Node Buffer 사용 | 런타임 내장(npm dep 아님) — zero-dep 유지 | 순수 Uint8Array + DataView — 동등하나 장황 |

## YAGNI 체크

- 추가 발견: GGUF 쓰기, 다중 아키텍처 지원, Q-quant, 텐서 캐시 LRU
- 결정: **N** — qwen2 F16 읽기 전용, 필요 텐서만

## Rollback plan

PR revert 1회. 신규 모듈만 — 상위 무접촉.

## Migration plan

N/A — 신규 추가, 기존 인터페이스 무변경.

## 구현 세션 실행 방법

- 설계: Fable / 구현: Haiku (Phase당 1세션). 표준 구현 프롬프트는 core-engine-index.md 참조 (경로만 gguf-phase-N.md로).

## 4-6 자동화 검증 결과 (라운드 1)

- **결정적 위반 0건**, alert 2건 (첫 라운드 통과)

### alert 항목 LLM 검토 (수동)

- alert 1~2 (검증 3): `f16ToF32`/`parseGguf`가 입출력 예제 표에 2~4행 등장 → **의도된 다중 예제** (정상/에러/경계 행 분리). 모순 아님

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 전 Step이 `src/gguf/**` 신규 생성, Do Not Touch(기존 src 전체)와 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 1 전제 = Phase 0 노출(parseGguf/GgufFile/GgmlType). 시그니처 일치
- 4-3 기술 제약 vs 코드: PASS — `.js` 확장자, `any` 0건, Node 내장(Buffer/fs)만(npm dep 0), 인덱스 접근 가드
- 4-4 동반 변경 완전성: PASS — 새 가드(경계 초과/magic/버전/미지원 타입/텐서 없음 throw) → 각 throw 경로 테스트 / 새 export → 소비자+테스트 / 파일 IO(load) 실패 전파 명시 + fromBuffer 단위 테스트 / 통합 테스트 env 게이트로 CI 회귀 0

### 4-5/4-7

codex skip (개인 학습 프로젝트). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
