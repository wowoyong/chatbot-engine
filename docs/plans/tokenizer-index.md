# tokenizer — Index (Segment 2: BPE 토크나이저)

Baseline: main@c486e1d (clean)

## 개요

자체 LLM 추론 엔진의 2번째 조각 — GGUF 메타의 vocab(151936)+merges(151387)로 **byte-level BPE 토크나이저**(encode/decode)를 순수 TS로 구현. Qwen2는 gpt2형 byte-level BPE + qwen2 pretokenizer 정규식. 설계 문서: `docs/design/2026-07-13-native-llm-inference-design.md`.

## 실측 확정값

- tokenizer.ggml.model="gpt2", pre="qwen2", tokens 151936, merges 151387
- byte-level: GPT-2 bytes_to_unicode 매핑 (256 바이트 → 유니코드 문자)
- special: `<|endoftext|>`=151643(bos/pad), `<|im_start|>`=151644, `<|im_end|>`=151645(eos)
- token_type 배열(151936): 1=normal, 3=control(special)

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | byte 매핑 + BPE encode/decode | 4 (신규) | Segment 1(GgufModel 메타) | bytesToUnicode, 정규식 pretokenize, BPE merge, 특수토큰 + 단위·통합 테스트 |

## 실행 순서

Phase 0 (단일).

## Segment 경계 (Out-of-Scope)

- 트랜스포머 forward → Segment 3
- 샘플링/어댑터 → Segment 4
- tokenizer 학습(merge 생성) → 없음 (GGUF merges 소비만)
- 완전한 정규식 일치(모든 유니코드 카테고리 edge) → qwen2 정규식 핵심만, 불일치 시 roundtrip로 안전

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `ls src/tokenizer 2>/dev/null` | 0 (신규) | — 해당 없음 |
| Adjacent Files (인접 파일) | `grep -rln "bytesToUnicode\|BPE\|merge" src/` | 0 hits | — 해당 없음 (신규 영역) |
| Byproducts (부산물) | 위험 선반영: 멀티바이트 UTF-8 경계, 알 수 없는 바이트, 빈 입력, 특수토큰 분리 | 4건 선반영 | In-Scope (4) — 코드 가드 |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/gguf/**`(Segment 1 완료), `src/llm/**`, 그 외 기존 src, 기존 plan | 소비만(GgufModel 메타 read) |
| **Touch-Minimal** | — 해당 없음 | |
| **Full Scope** | `src/tokenizer/**` (신규) | 통상 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan landing.

## BE-FE 계약 경계 (1-3.H)

SKIP — 순수 문자열↔토큰 변환, wire 없음.

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | pretokenizer 정규식이 reference와 미세 불일치 → 토큰 ID 다름 | M | M | qwen2 정규식 핵심 구현 + encode→decode 왕복 무손실 보장(품질만 영향, 동작 유지). 통합 테스트로 알려진 문자열 spot-check |
| R2 | byte-level 멀티바이트(한글 3바이트) 처리 오류 | M | H | UTF-8 바이트 단위 인코딩 후 byte→unicode 매핑 (GPT-2 방식) + 한글 왕복 테스트 |
| R3 | 특수토큰(`<|im_start|>` 등)이 BPE로 쪼개짐 | M | H | 특수토큰을 정규식 이전에 분리 매칭 → 단일 ID |
| R4 | merge rank 순서 오류 | L | H | GGUF merges 배열 순서 = rank (0이 최우선) |

## Acceptance Criteria

- [ ] AC1: bytesToUnicode가 256 바이트를 유일 유니코드로 매핑 (단위)
- [ ] AC2: encode→decode 왕복이 원문과 일치 — 영어·한글·특수문자 (단위)
- [ ] AC3: 특수토큰 `<|im_start|>`가 단일 토큰 ID로 encode (통합, 실파일)
- [ ] AC4: 알려진 문자열의 토큰 ID가 참조와 일치 (통합, spot-check)
- [ ] AC5: 빈 문자열·알 수 없는 바이트 처리 (단위)
- [ ] AC6: `npm test` 회귀 없음

## Decision log

| 결정 | 이유 | 대안 |
|------|------|------|
| qwen2 정규식 pretokenize | reference 토큰 ID 일치 목표 | 정규식 없이 전체 BPE — reference 불일치 |
| 왕복 무손실 보장 우선 | 정규식 불일치해도 동작 유지 | 완벽 일치만 — 구현 부담 큼 |
| 특수토큰 선분리 | BPE 쪼개짐 방지 | vocab에만 의존 — 쪼개질 위험 |

## YAGNI 체크

- 추가 발견: tokenizer 학습, 다른 vocab 지원, 캐시
- 결정: **N** — qwen2 encode/decode만

## Rollback plan

PR revert 1회. 신규 모듈만.

## Migration plan

N/A — 신규 추가.

## 구현 세션 실행 방법

- 설계: Fable / 구현: Haiku. 표준 구현 프롬프트는 core-engine-index.md 참조 (경로 tokenizer-phase-N.md).

## 4-6 자동화 검증 결과 (라운드 1)

- **결정적 위반 0건**, alert 소수 (입출력 예제 다중 행 — 의도된 다중 예제, 모순 아님)

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 신규 모듈 위주, 수정 대상과 Do Not Touch 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 전제 = 직전 노출과 시그니처 일치
- 4-3 기술 제약 vs 코드: PASS — .js 확장자, any 최소(GGUF 메타 캐스팅만), 런타임 의존성 0
- 4-4 동반 변경 완전성: PASS — 새 가드/export → 테스트·소비자 동반, 통합 테스트 env 게이트로 CI 회귀 0

### 4-5/4-7

codex skip (개인 학습 프로젝트). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
