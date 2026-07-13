# capture2 — Index (Track D 캡처 품질)

Baseline: main@b3bde1b (clean)

## 개요

Track D — 캡처 품질: Ollama native `format`(JSON 스키마)로 구조화 출력(D-1), 추출 프롬프트 노이즈 필터(D-2), `/captured` 목록(D-3). Segment 6 LangChain 실험에서 `withStructuredOutput`의 효과를 확인했고, 그 대응물(Ollama `format`)을 밑바닥으로 이식한다.

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 구조화 출력 + 프롬프트 + 목록 | 8 (수정 5, 신규 1, 테스트 조정) | 없음 | ChatOptions.format, OllamaClient 전달, extractor 스키마+프롬프트, listCaptured, /captured 명령·라우트 + 테스트 |

## 실행 순서

Phase 0 (단일).

## Segment 경계 (Out-of-Scope)

- 인터랙티브 삭제 UX — 저장물이 평문 md라 `rm`으로 충분 (YAGNI). 목록만 제공
- 매 턴 자동 캡처 — 품질 관찰 후 별도
- 추출 골든 세트 — 초기엔 프롬프트 개선 + 수동 관찰

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `grep -n "options.think\|body: JSON.stringify" src/llm/ollama-client.ts` | body 조립 1곳 | In-Scope (1) — format 조건부 추가 |
| Adjacent Files (인접 파일) | `grep -rn "client.chat(" src/knowledge` | extractor 1곳 | In-Scope (1) — format 전달 |
| Byproducts (부산물) | 스키마 카테고리 enum ↔ KNOWLEDGE_CATEGORIES 동기화 | 단일 소스 필요 | In-Scope (1) — 스키마가 KNOWLEDGE_CATEGORIES 참조 |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/chat/**`, `src/context/**`, `src/rag/**`, `src/server/public/**`, 기존 plan | 캡처 외 무변경 |
| **Touch-Minimal** | `src/llm/types.ts`(format 필드), `src/llm/ollama-client.ts`(body 1줄), `src/cli/main.ts`·`src/server/http-server.ts`(명령/라우트 추가), `CLAUDE.md` | 본 변경 외 재수정 금지 |
| **Full Scope** | `src/knowledge/extractor.ts`(스키마+프롬프트), `src/knowledge/capture-store.ts`(listCaptured), 관련 테스트 | 통상 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — 기존 plan landing.

## BE-FE 계약 경계 (1-3.H)

활성 — 신규 wire: `GET /api/captured` → `{items:[{path,title,category}]}`. UI 노출은 본 plan 밖(선택). 서버 테스트가 형식 고정.

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | Ollama format이 구버전 미지원 | L | L | format optional — 미전달 시 기존 손파싱 경로 유지 |
| R2 | format 스키마와 KNOWLEDGE_CATEGORIES 불일치 | L | M | 스키마 enum이 KNOWLEDGE_CATEGORIES를 직접 참조 (단일 소스) |
| R3 | 8B가 여전히 내용 오류(빈 items 등) | M | L | 구조화는 형식만 보장 — D-2 프롬프트로 노이즈 완화, 재시도 안내 유지 |

## Acceptance Criteria

- [ ] AC1: extractor가 format 스키마를 전달 (단위)
- [ ] AC2: parseCandidates가 array·{items} 양쪽 파싱 (단위)
- [ ] AC3: 프롬프트가 어시스턴트 맞장구 제외 지시 포함 (단위 — 프롬프트 문자열)
- [ ] AC4: `/captured` 목록 + `GET /api/captured` (단위/수동)
- [ ] AC5: `npm test` 회귀 없음

## Decision log

| 결정 | 이유 | 대안 |
|------|------|------|
| object-wrapper `{items:[]}` 스키마 | Ollama format은 object 스키마 선호 (LC 실험서 검증) | top-level array — 지원 불확실 |
| parseCandidates가 양쪽 수용 | format 미지원 fallback + 기존 테스트 무churn | items만 — 하위호환 깨짐 |
| 삭제는 rm | 평문 md, 단일 사용자 (YAGNI) | 인터랙티브 삭제 — 과설계 |

## YAGNI 체크

- 추가 발견: 캡처 편집 UI, 카테고리 재분류, 중복 병합
- 결정: **N** — 목록 + 구조화 출력만

## Rollback plan

PR revert 1회. format optional이라 부분 revert 안전.

## Migration plan

N/A — ChatOptions.format·listCaptured 모두 추가, 기존 호출자 무영향.

## 구현 세션 실행 방법

- 설계: Fable / 구현: Haiku. 표준 구현 프롬프트는 core-engine-index.md 참조.

## 4-6 자동화 검증 결과

(스크립트 실행 후 첨부)
