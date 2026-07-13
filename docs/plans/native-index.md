# native — Index (Segment 4: 샘플러 + LlmClient 어댑터)

Baseline: main@c486e1d (clean)
구현 완료: `main@3593f0d` (★AC5: 자체 엔진 생성 'France 수도'→'巴黎'. 테스트 179)

## 개요

자체 LLM 추론 엔진의 마지막 조각 — 샘플러(greedy/temperature/top-p) + ChatML 템플릿 + `NativeLlmClient`(LlmClient 구현)로 tokenizer+transformer를 챗봇에 연결. env로 Ollama↔자체 엔진 전환. 설계 문서: `docs/design/2026-07-13-native-llm-inference-design.md`.

## 실측 확정값

- ChatML: `<|im_start|>role\n{content}<|im_end|>\n` 반복 + `<|im_start|>assistant\n`. system 기본 "You are Qwen, created by Alibaba Cloud. You are a helpful assistant."
- eos = `<|im_end|>` (151645). bos = `<|endoftext|>` (151643)

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 샘플러 + 템플릿 + NativeLlmClient + 전환 | 8 (신규 5, 수정 3) | Segment 1·2·3 | sampleToken, ChatML, NativeLlmClient(chatStream), GgufModel 메타 접근자, bootstrap 전환 + 테스트 |

## 실행 순서

Phase 0 (단일).

## Segment 경계 (Out-of-Scope)

- KV 캐시 압축/페이징 → 없음
- 다중 대화 배치 → 없음
- 웹 UI에 엔진 선택 토글 → env로만 (필요 시 후속)

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `grep -n "OllamaClient\|new NativeLlmClient" src/app/bootstrap.ts` | OllamaClient 생성 1곳 | In-Scope (1) — env 분기로 NativeLlmClient 선택 |
| Adjacent Files (인접 파일) | `grep -rln "GgufModel\|metadata" src/tokenizer` | tokenizer 통합 테스트가 private gguf 캐스팅 | In-Scope (1) — GgufModel.metadataArray 접근자 추가 후 캐스팅 제거 |
| Byproducts (부산물) | 증분 decode 멀티바이트 경계, eos 정지, maxTokens 상한, top-p 정렬 안정성 | 4건 선반영 | In-Scope (4) — 코드+테스트 |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/gguf/parser.ts`·`reader.ts`·`f16.ts`·`types.ts`, `src/transformer/**`, `src/rag/**`, `src/context/**`, `src/store/**`, `src/knowledge/**`, 기존 plan | 소비만 |
| **Touch-Minimal** | `src/gguf/model.ts`(metadataArray 접근자 1개), `src/tokenizer/__tests__/bpe.integration.test.ts`(캐스팅→접근자 정리), `src/app/bootstrap.ts`(env 분기), CLAUDE.md | 본 변경 외 재수정 금지 |
| **Full Scope** | `src/native/**` (신규: sampler, chat-template, native-client) | 통상 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan landing.

## BE-FE 계약 경계 (1-3.H)

활성 — NativeLlmClient가 LlmClient 계약을 구현: `chatStream(messages, options): AsyncGenerator<string, {promptTokens?, responseTokens?}>`. TurnMeta 채널(ux Segment)과 호환 — content yield + 완료 시 토큰 수 return. bootstrap의 retriever/session은 무변경(인터페이스 뒤 교체).

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | 증분 decode가 멀티바이트 중간에 깨진 문자 yield | M | M | 누적 ids 전체 decode 후 delta yield (부분 문자 안전) |
| R2 | eos 미감지 → 무한 생성 | M | M | eos(151645) 또는 maxTokens 상한 정지 |
| R3 | Segment 3 forward 부정확 → 무의미 생성 | M | H | Segment 3 AC4(Ollama 교차검증) 선통과 전제. 본 Segment는 조립만 |
| R4 | 속도(토큰당 수 초) → 긴 응답 지연 | H | L | maxTokens 기본 낮게(예: 256), 설계 허용 |
| R5 | bootstrap 전환이 기존 Ollama 경로 회귀 | L | M | env 미설정 시 기존 OllamaClient 유지 + 기존 테스트 회귀 게이트 |

## Acceptance Criteria

- [ ] AC1: sampleToken greedy가 argmax 반환, temperature/top-p가 확률적 (단위, 주입 rng)
- [ ] AC2: ChatML 템플릿이 규격대로 조립 (단위)
- [ ] AC3: NativeLlmClient.chatStream이 prefill→생성→eos 정지, 증분 텍스트 yield (단위, Fake transformer)
- [ ] AC4: 증분 decode가 멀티바이트(한글) 안전 (단위)
- [ ] AC5: 실모델로 자체 엔진 한국어/영어 생성 (수동 통합) + Ollama와 별개 동작
- [ ] AC6: `npm test` 회귀 없음, env 미설정 시 기존 Ollama 경로 유지

## Decision log

| 결정 | 이유 | 대안 |
|------|------|------|
| 누적 decode delta yield | 멀티바이트 안전 | 토큰별 decode — 부분 문자 깨짐 |
| rng 주입 (sampleToken) | 확률적 샘플링 테스트 가능 | Math.random 직접 — 테스트 불가 |
| env 전환(LLM_ENGINE=native) | 기존 Ollama 무변경 병행 | Ollama 대체 — 설계 위반 |
| GgufModel.metadataArray 접근자 | 캐스팅 해킹 제거(단일 소스) | 캐스팅 유지 — 취약 |

## YAGNI 체크

- 추가 발견: 웹 UI 엔진 토글, 샘플러 프리셋, 스트리밍 취소, KV 캐시 저장
- 결정: **N** — env 전환 + 기본 샘플러만

## Rollback plan

PR revert 1회. env 미설정 시 기존 동작 — 부분 revert 안전.

## Migration plan

N/A — LlmClient 구현 추가, 인터페이스 무변경.

## 구현 세션 실행 방법

- 설계: Fable / 구현: Haiku. **Segment 3(forward) 교차검증 통과 후 진행** (전제). 표준 구현 프롬프트는 core-engine-index.md 참조.

## 4-6 자동화 검증 결과 (라운드 1)

- **결정적 위반 0건**, alert 소수 (입출력 예제 다중 행 — 의도된 다중 예제, 모순 아님)

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 신규 모듈 위주, 수정 대상과 Do Not Touch 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 전제 = 직전 노출과 시그니처 일치
- 4-3 기술 제약 vs 코드: PASS — .js 확장자, any 최소(GGUF 메타 캐스팅만), 런타임 의존성 0
- 4-4 동반 변경 완전성: PASS — 새 가드/export → 테스트·소비자 동반, 통합 테스트 env 게이트로 CI 회귀 0

### 4-5/4-7

codex skip (개인 학습 프로젝트). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
