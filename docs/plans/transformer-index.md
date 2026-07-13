# transformer — Index (Segment 3: 트랜스포머 forward)

Baseline: main@c486e1d (clean)

## 개요

자체 LLM 추론 엔진의 3번째 조각 — Qwen2 트랜스포머 forward pass를 순수 TS로 밑바닥 구현. 수학 커널(matmul/RMSNorm/RoPE/softmax/SiLU) + GQA 어텐션(KV 캐시) + SwiGLU MLP → 다음 토큰 logits. tied embeddings(별도 lm_head 없음). 설계 문서: `docs/design/2026-07-13-native-llm-inference-design.md`.

## 실측 확정값 (텐서 구조)

- 24층. 각 층: attn_norm[896]F32, attn_q[896,896]+bias[896], attn_k[896,128]+bias[128], attn_v[896,128]+bias[128], attn_output[896,896], ffn_norm[896]F32, ffn_gate[896,4864], ffn_up[896,4864], ffn_down[4864,896]
- 전역: token_embd[896,151936] — 임베딩+tied lm_head, output_norm[896]F32
- GQA: q head 14, kv head 2, head_dim 64. RoPE θ=1e6. RMS eps≈1e-6
- **GGUF 텐서 레이아웃**: weight ne=[in,out], 원소 (o,j) = data[o*in + j] → y[o]=bias[o]+Σⱼ data[o*in+j]·x[j]. 임베딩: token t = data[t*896 .. +896]

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 수학 커널 | 4 (신규) | Segment 1(GgufModel) | linear/rmsNorm/softmax/silu/rope 순수 함수 + 단위 테스트 |
| 1 | 트랜스포머 forward | 4 (신규) | Phase 0 | GQA 어텐션+KV캐시, SwiGLU MLP, 층 루프, tied logits + 통합(Ollama 교차검증) |

## 실행 순서

Phase 0 → 1 (순차).

## Segment 경계 (Out-of-Scope)

- 샘플링/어댑터 → Segment 4
- 배치 처리 → 단일 시퀀스만
- 속도 최적화(SIMD/멀티스레드) → 없음 (교육)
- flash attention → 표준 스코어+softmax

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `ls src/transformer 2>/dev/null` | 0 (신규) | — 해당 없음 |
| Adjacent Files (인접 파일) | `grep -rln "rmsNorm\|softmax\|rope\|attention" src/` | 0 hits | — 해당 없음 (신규) |
| Byproducts (부산물) | 위험 선반영: 텐서 레이아웃 오해(전치), 인과 마스크 누락, GQA head 매핑 오류, KV 캐시 오프셋, 수치 overflow(softmax) | 5건 선반영 | In-Scope (5) — 코드+테스트 |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/gguf/**`, `src/tokenizer/**`, `src/llm/**`, 그 외 기존 src, 기존 plan | GgufModel 소비만 |
| **Touch-Minimal** | — 해당 없음 | |
| **Full Scope** | `src/transformer/**` (신규) | 통상 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan landing.

## BE-FE 계약 경계 (1-3.H)

SKIP — 순수 수치 연산, wire 없음. (교차 검증 계약: Ollama 동일 모델 logits 상위 토큰 일치 — Phase 1 통합 테스트.)

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | GGUF 텐서 레이아웃 오해(전치/스트라이드) → logits 틀림 | H | H | 레이아웃 명시(ne=[in,out]) + 단일 층 커널 단위 테스트 + Ollama 교차검증(핵심 게이트) |
| R2 | RoPE 규약 불일치(NeoX vs GPT) | M | H | HF Qwen2 rotate_half 규약 명시 + 교차검증 |
| R3 | GQA head→kv head 매핑 오류 | M | H | kv = floor(qHead / (nHeads/nKvHeads)) 명시 + 테스트 |
| R4 | 인과 마스크 누락 → 미래 토큰 참조 | M | H | 스코어 j>pos는 -Inf + 테스트 |
| R5 | softmax overflow(큰 스코어) | L | M | max 빼기 후 exp (수치 안정) |
| R6 | 순수 TS 속도(토큰당 수 초) | H | L | 설계 허용(교육). 짧은 프롬프트로 교차검증 |

## Acceptance Criteria

- [ ] AC1: 커널(linear/rmsNorm/softmax/silu/rope)이 손계산 값과 일치 (단위)
- [ ] AC2: GQA head 매핑·인과 마스크가 정확 (단위)
- [ ] AC3: 실 모델 forward가 유한 logits 반환, shape [vocab] (통합)
- [ ] AC4: 알려진 프롬프트의 argmax 다음 토큰이 Ollama와 일치 (통합, 교차검증 — 핵심)
- [ ] AC5: KV 캐시로 증분 forward가 전체 재계산과 동일 logits (단위/통합)
- [ ] AC6: `npm test` 회귀 없음

## Decision log

| 결정 | 이유 | 대안 |
|------|------|------|
| 단일 시퀀스 + KV 캐시 | 챗봇 증분 생성에 적합 | 배치 — 불필요 |
| tied embeddings(token_embd 재사용) | 실 모델에 별도 output.weight 없음 | 별도 lm_head — 존재 안 함 |
| Ollama logits 교차검증 게이트 | 수치 정확도 객관 검증 | 자체 판단만 — 미검증 위험 |
| Float32Array 전면 사용 | 밑바닥 성능+명시성 | number[] — 느리고 모호 |

## YAGNI 체크

- 추가 발견: 배치, KV 캐시 페이징, 어텐션 최적화, 다른 아키텍처
- 결정: **N** — qwen2 단일 시퀀스 forward만

## Rollback plan

PR revert 1회. 신규 모듈만.

## Migration plan

N/A — 신규 추가.

## 구현 세션 실행 방법

- 설계: Fable / 구현: Haiku. **단, Phase 1(forward)은 교차검증 실패 시 반복 조정 가능성 높음** — Haiku 구현 후 메인이 Ollama 교차검증하고 불일치 시 레이아웃/RoPE 재점검. 표준 구현 프롬프트는 core-engine-index.md 참조.

## 4-6 자동화 검증 결과 (라운드 1)

- **결정적 위반 0건**, alert 소수 (입출력 예제 다중 행 — 의도된 다중 예제, 모순 아님)

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 신규 모듈 위주, 수정 대상과 Do Not Touch 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 전제 = 직전 노출과 시그니처 일치
- 4-3 기술 제약 vs 코드: PASS — .js 확장자, any 최소(GGUF 메타 캐스팅만), 런타임 의존성 0
- 4-4 동반 변경 완전성: PASS — 새 가드/export → 테스트·소비자 동반, 통합 테스트 env 게이트로 CI 회귀 0

### 4-5/4-7

codex skip (개인 학습 프로젝트). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
