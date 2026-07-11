# rag — Implementation Plan Index

Baseline: main@f978775 (clean)

## 개요

Segment 3 — RAG 밑바닥 구현: 마크다운 청킹 → Ollama 임베딩(`nomic-embed-text`, 설치·API 검증 완료) → in-memory 코사인 검색 → 매 턴 자동 프롬프트 주입. 설계 문서 Phase 3에 해당. 주입 방식(매 턴 자동 + 유사도 임계값)은 사용자 승인 완료.

## Phases

| Phase | 이름 | 파일 수 | 의존성 | 설명 |
|-------|------|--------|--------|------|
| 0 | 청킹 + 코사인 | 4 (신규) | 없음 | 순수 함수 + 테스트 10 |
| 1 | atomic 유틸 + Embedder | 6 (신규 4, 수정 2) | 없음 | writeFileAtomic 추출(SessionStore 리팩터), OllamaEmbedder + 테스트 9 |
| 2 | VectorIndex + Indexer | 4 (신규) | Phase 0·1 | 검색/저장/로드 + md 스캔·배치 임베딩 + 테스트 9 |
| 3 | Retriever + 통합 | 6 (신규 2, 수정 4) | Phase 2 | 검색 주입, prepare 확장, `/index` 명령 + 테스트 7 |

## 실행 순서

Phase 0 → 1 → 2 → 3. (0과 1은 상호 독립이지만 순차 실행 — 테스트 수 기대값이 누적 기준)

## Segment 경계 (Out-of-Scope — 사전 분석 보고에서 승인)

- 파일 해시 기반 증분 인덱싱 — `/index` 전체 재구축으로 갈음 (수백 청크 규모에서 수십 초 내)
- 외부 벡터 DB(sqlite-vec 등) — 의존성 0 원칙, in-memory 전수 비교로 충분
- 재랭킹(reranking)·하이브리드 검색(BM25+벡터) — Segment 6 LangChain 비교 시 학습 소재로 보류
- wiki 레포 연동 — Segment 4 (OpenWiki)에서 RAG_DOCS_DIR을 wiki 경로로 지정하는 것으로 연결

## Sweep Results

| 차원 | 명령 | hit | 분류 |
|------|------|-----|------|
| Same File (같은 파일) | `grep -n "line === '/" src/cli/main.ts` | 2 hits (/exit, /clear) | In-Scope (1) — `/index`를 동일 dispatch 패턴으로 추가 (Phase 3 Step 4) |
| Adjacent Files (인접 파일) | `grep -rn "FetchLike" src/` + atomic write 로직 위치 확인 | FetchLike 3 hits(단일 정의) / atomic 로직 SessionStore 1곳 | In-Scope (2) — FetchLike import 재사용(재정의 금지), atomic write 공용 유틸 추출 + SessionStore 리팩터 (Phase 1) |
| Byproducts (부산물) | `grep -rn "\.prepare(" src/` (테스트 제외) | 1 hit — session.ts만 | In-Scope (1) — prepare 선택 4번째 인자 확장 시 호출처 1곳 동반 갱신 (Phase 3 Step 3) |

## File Touch Policy

| 분류 | 파일 | 정책 |
|------|------|------|
| **Do Not Touch** | `src/llm/ollama-client.ts`, `src/llm/ndjson.ts`, `src/llm/errors.ts`, `docs/superpowers/specs/**`, `docs/plans/core-engine-*.md`, `docs/plans/memory-*.md` | 기존 LLM 코어와 landing된 계획 문서 무변경 |
| **Touch-Minimal** | `src/llm/types.ts` (Embedder 추가만), `src/store/session-store.ts` (save 리팩터만), `CLAUDE.md` (1줄), 기존 테스트 파일 2개 (케이스 추가만) | 본 변경 외 기존 내용 재수정 금지 |
| **Full Scope** | `src/rag/**` (신규), `src/store/atomic-file.ts` (신규), `src/llm/ollama-embedder.ts` (신규), `src/context/context-manager.ts` (prepare 확장), `src/chat/session.ts`, `src/cli/main.ts` | 통상 품질 기준 |

## 형제 plan 교차 (1-3.G)

SKIP — core-engine·memory plan 모두 구현 완료·landing (`main@f978775` 기준 clean). 동시 landing 형제 없음.

## BE-FE 계약 경계 (1-3.H)

SKIP — 단일 프로세스 CLI. 신규 wire는 Ollama `/api/embed`(로컬 실측으로 응답 형태 `{embeddings: number[][]}` 검증 완료 — Phase 1 Step 5 타입 가드가 미러링)와 인덱스 JSON(스키마 가드 + 손상 테스트 동반).

## Risk Register

| # | 위험 | 확률 | 영향 | 완화 |
|---|-----|------|------|-----|
| R1 | 무관 질문에 저품질 발췌 주입 → 답변 오염 | M | M | minScore 0.35 + topK 4 + 프롬프트에 "관련 없으면 무시하라" 명시 |
| R2 | 문서 수정 후 인덱스 미갱신(stale) | M | L | 시작 배너에 인덱스 생성 시각 표시 + `/index` 재구축 안내 |
| R3 | 임베딩 모델 교체로 벡터 차원/공간 불일치 | L | M | 인덱스에 model 기록 — 로드 시 불일치면 무시+재구축 안내 (CLI Step 4) |
| R4 | 검색(임베딩 호출) 실패로 대화 중단 | L | M | session에서 try/catch — 발췌 없이 진행 (테스트 동반) |
| R5 | 발췌 블록이 컨텍스트 예산 압박 | M | L | contextBlock을 fixed로 포함해 overhead에 자동 반영 — 트리밍/요약이 흡수 |

## Acceptance Criteria

- [ ] AC1: `/index` 실행 시 `docs/` md가 인덱싱되고 청크 수가 보고된다 (수동)
- [ ] AC2: 인덱스 존재 시 문서 기반 질문("컨텍스트 예산 기본값은?")에 문서 근거로 답한다 (수동)
- [ ] AC3: 무관 질문에는 발췌가 주입되지 않는다 — minScore 필터 (단위 테스트 — Phase 3 Step 5)
- [ ] AC4: 검색 실패 시 발췌 없이 대화가 계속된다 (단위 테스트 — Phase 3 Step 6)
- [ ] AC5: 재시작 시 인덱스가 자동 로드되고, 모델 불일치면 무시+안내한다 (수동)
- [ ] AC6: `npm test` 80 passed — 기존 45개 회귀 없음 (특히 SessionStore 리팩터 후 store 6개)

## Decision log + Alternatives considered

| 결정 | 선택 이유 | 검토했으나 안 한 대안 |
|------|----------|--------------------|
| `/api/embed` 배치(16) 순차 호출 | 단일 거대 요청의 메모리/타임아웃 회피, wire 검증 완료 | 구형 `/api/embeddings`(단건) — 청크당 1요청은 느림 |
| in-memory 전수 코사인 | 수백 청크에 충분, 원리 노출이 학습 목적 | ANN/벡터 DB — 의존성 + 블랙박스화 |
| minScore 0.35 고정 기본 | 무관 주입 방지, RetrieverConfig로 조정 가능 | 동적 임계값 — 근거 데이터 없이 복잡도만 증가 |
| 인덱스 손상 시 null (`.bak` 없음) | 인덱스는 `/index`로 재생성 가능한 파생물 — 세션(사용자 데이터)과 다른 등급 | 세션과 동일한 .bak 보존 — 불필요한 파일 누적 |
| `ContextRetriever`를 session에 구조적 정의 | chat 레이어가 rag를 import하지 않음 — 레이어 방향 유지 | session이 rag.Retriever 직접 의존 — 결합도 증가 |
| 발췌를 fixed(system)로 예산 포함 | 트리밍·요약과 자동 공존 (overhead 산정에 반영) | 예산 밖 별도 취급 — 총량 초과 위험 |
| atomic write 유틸 추출 | RAG 인덱스 저장이 같은 로직 필요 — 중복 방지 (기존 테스트가 회귀 검증) | Store마다 인라인 중복 — sweep 원칙 위반 |
| createdAt 인자 주입 | 테스트 결정성 (고정 문자열) | 내부 `new Date()` — 테스트 불가 |

## YAGNI 체크

- 추가 발견 추상화: 다중 인덱스(소스별), 청크 메타데이터 확장(라인 번호·앵커), 검색 결과 캐시, 인덱싱 진행률 표시
- 사용자 결정: **N (전부 제외)** — RetrieverConfig(topK/minScore)와 ChunkOptions만 노출

## Rollback plan

- 단순 revert: 가능 — PR revert 1회. 수정 파일 6개는 전부 하위 호환 변경(선택 인자/필드)
- 산출물: `.chatbot/rag-index.json`은 gitignore 대상 — revert와 무관, 구버전 CLI는 무시
- DB/외부 시스템: N/A

## Migration plan

N/A — breaking change 없음. prepare 4번째 인자·ChatSessionConfig.retriever 모두 선택적, 기존 호출자 무영향.

## 구현 세션 실행 방법

- 설계: Fable (본 세션) / 구현: **Haiku** (Phase당 1세션)

### 표준 구현 프롬프트

```
당신은 구현 전담 엔지니어입니다.

## 게이트 (최우선)
1. `cat docs/plans/rag-phase-N.md` 를 실행하세요.
2. 파일이 없으면: "❌ Phase N 계획서가 없습니다." 출력 후 즉시 종료.
3. 파일에 `## Step 1` 섹션이 없으면: "❌ 계획서에 Step이 없습니다." 출력 후 즉시 종료.

## 규칙
- 계획서의 Code를 그대로 사용 — 자체 판단으로 코드를 작성하지 마세요
- Anchor 위치에 정확히 생성/삽입/교체 (수정 Step은 앵커 텍스트 유일성 확인)
- "Do Not Touch" 목록의 파일/코드를 건드리지 않음
- 각 Step의 Verify 실행 — 실패 시 해당 Step의 Code 재확인 (구현을 임의 변경 금지)
- 계획서에 없는 파일을 수정하지 않음

## 최종 게이트
1. Phase의 "최종 검증" 자동 검증 명령 실행, 결과 보고
2. Plan Fidelity Check:
   node "$HOME/.claude/plugins/cache/rtb-tools/rtb/1.3.90/skills/plan/scripts/check-plan-fidelity.js" \
     docs/plans/rag-phase-N.md <이번 Phase에서 생성/수정한 모든 src 파일>
   exit 0=PASS / 1=누락 토큰 보완 / 스크립트 부재 시 최종 검증으로 갈음
```

## 4-6 자동화 검증 결과 (라운드 2)

- 라운드 1: 결정적 위반 1건 (검증 5 — chunker 구현 코드의 정규식 `.test(line)`이 테스트 서명으로 오탐) → `line.match(...) !== null`로 변경해 해소 (동작 동일)
- 라운드 2: **결정적 위반 0건**, alert 4건

### alert 항목 LLM 검토 (수동)

- alert 1~4 (검증 3): `chunkMarkdown`/`cosineSimilarity`/`embed`/`search`가 각 입출력 예제 표에 2~3행 등장 → 전부 **의도된 다중 예제** (정상/에러/경계 행 분리). 모순 아님

### 교차 검증 4-1~4-4 (수동)

- 4-1 Do Not Touch 역교차: PASS — 수정 대상(types.ts, session-store.ts, context-manager.ts, session.ts, main.ts, 테스트 2, CLAUDE.md)과 Do Not Touch(ollama-client/ndjson/errors, specs, 기존 plan) 교집합 없음
- 4-2 크로스 Phase 인터페이스: PASS — Phase 2 전제 = Phase 0·1 노출, Phase 3 전제 = Phase 1·2 노출 (시그니처 일치). prepare 확장·ChatSessionConfig 추가 필드 모두 선택적으로 하위 호환 명시
- 4-3 기술 제약 vs 코드: PASS — `.js` 확장자, `any` 0건, `.at()`/`??` 가드, 테스트 FS `.test-tmp/`만, FetchLike 재정의 없음
- 4-4 동반 변경 완전성: PASS — 새 가드(코사인 차원/임베딩 형식·개수/인덱스 스키마) → 각 throw·null 경로 테스트 / atomic 추출 → 호출처(SessionStore) 갱신 + 미사용 import 제거 + 기존 테스트 회귀 검증 / prepare 시그니처 확장 → 호출처 1곳(session) 갱신 + 경로 테스트 / retriever 실패 설계(try/catch) 명시

### 4-5/4-7

codex skip (동일 사유 — 개인 학습 프로젝트). 4-7은 4-6 스크립트 + 상기 수동 교차 검증으로 갈음.
