# 자체 LLM 추론 엔진 — 설계 문서

- 날짜: 2026-07-13
- 상태: 사용자 승인 (브레인스토밍 세션), 계획 진행
- 목적: "LLM이 실제로 어떻게 동작하는가"를 밑바닥 구현으로 학습

## 목표

사전학습된 소형 트랜스포머(**Qwen2.5-0.5B-Instruct**)의 가중치를 직접 로드해 **forward pass(추론)를 순수 TypeScript로 밑바닥 구현**하고, 기존 `LlmClient` 인터페이스 뒤에 **두 번째 구현체**로 붙인다. Ollama는 일상 대화용으로 유지하고, 자체 엔진은 env로 선택 실행한다.

## 확정 결정 (사용자 승인)

| 항목 | 결정 |
|------|------|
| 구현 수준 | 추론 엔진 밑바닥 (학습 없음, 사전학습 가중치 forward만) |
| 대상 모델 | Qwen2.5-0.5B-Instruct (한국어 가능 + 아키텍처 단순: RoPE·RMSNorm·SwiGLU·GQA, QK-norm 없음) |
| 가중치 소스 | Ollama가 받아둔 GGUF (F16 우선 — dequant 단순) |
| 의존성 | zero-dep 순수 TS (느려도 됨 — 토큰당 수 초 허용, 교육 목적) |
| 통합 | LlmClient 인터페이스 뒤 두 번째 구현체 — RAG·메모리·웹UI 무변경 |

## 아키텍처 (4개 독립 컴포넌트)

```
GGUF 파일 (qwen2.5:0.5b)
   │
① GgufLoader        헤더·메타데이터·텐서 파싱, F16→F32 dequant → 가중치 맵 + 하이퍼파라미터
   ▼
② BpeTokenizer      GGUF 메타의 vocab+merges로 BPE 인코딩/디코딩 (byte-level 멀티바이트)
   ▼
③ Transformer       임베딩 → [RMSNorm→RoPE 어텐션(GQA+KV캐시)→RMSNorm→SwiGLU MLP] ×N → logits
   ▼
④ Sampler+Adapter   greedy/temperature/top-p → LlmClient.chatStream 어댑터 (토큰 단위 yield)
```

## 핵심 설계 원칙

1. **각 컴포넌트는 순수 함수/자료구조** — RMSNorm·RoPE·softmax·matmul·BPE를 알려진 입출력으로 독립 단위 테스트.
2. **행렬 연산 밑바닥** — `Float32Array`로 matmul/dot/softmax 직접 구현 (학습의 핵심).
3. **KV 캐시** — 매 토큰 전체 재계산 방지 (챗봇 컨텍스트 관리와 연결).
4. **LlmClient 경계 재사용** — 자체 엔진이 인터페이스만 만족하면 상위 전체 무변경.

## Segment 분할 (각 Segment = 독립 spec→plan→구현 사이클)

| Segment | 컴포넌트 | 검증 |
|---------|----------|------|
| 1 | GgufLoader (파싱 + F16 dequant) | 알려진 텐서 shape/값, 하이퍼파라미터 추출 |
| 2 | BpeTokenizer | encode→decode 왕복, 한국어 멀티바이트, 알려진 토큰 ID 대조 |
| 3 | Transformer forward (수학 커널 → 한 층 → 전체) | 참조 logits 상위 토큰 일치 |
| 4 | Sampler + LlmClient 어댑터 + 웹/CLI 전환 | 실제 한국어 생성 |

본 문서 이후 **Segment 1부터** 개별 계획서로 진행한다.

## 테스트 전략

- 수학 커널(RMSNorm/RoPE/softmax/matmul): 손계산 가능한 작은 입력으로 단위 테스트.
- 토크나이저: 왕복 + 알려진 문장 토큰 ID 대조.
- forward pass: Ollama의 같은 모델 logits와 상위 토큰 일치로 교차 검증.
- 기존 144 테스트 회귀 0 (자체 엔진은 순수 추가, LlmClient 뒤).

## 명시적 비목표

- 학습/파인튜닝 없음.
- 속도 최적화 없음 (느려도 됨).
- 양자화 포맷(Q4_K 등) 미지원 — F16만.
- Ollama 대체 아님 — 병렬 선택지 (env로 전환).

## 리스크

- **[대]** 순수 TS로 0.5B 추론이 실제로 동작할지 (수치 정확도·속도) — Segment 3에서 참조 logits 교차 검증으로 조기 확인.
- **[중]** BPE 토크나이저의 한국어 byte-level 처리 복잡도 — Segment 2를 독립 검증.
- **[중]** GGUF F16 텐서 레이아웃·dequant 정확도 — Segment 1을 실제 파일로 검증.
