# lc-compare — Segment 6 실행 계획 (실험형)

Baseline: main@e9768a4 (clean)

## 개요

Segment 6 — 엔진의 전기능(대화 스트리밍·메모리 트리밍/요약·영속화·RAG·knowledge-capture)을 LangChain/LangGraph로 재구현하고 비교 문서를 작성한다. **전기능 패리티**는 사용자 승인.

> **rtb:plan 형식 예외 (사유 명시)**: 실험/비교 목적 코드 — 외부 API(LangChain v1)는 계획 시점 스모크 테스트로 실측 확정했고(아래), 본 엔진과 완전 격리되며 단위 테스트를 면제(LangChain 객체 mocking 비용이 학습 가치 대비 명백히 큼 — 실행 AC로 갈음)하므로 Haiku 위임 대신 메인 세션이 직접 구현한다. 본 엔진 테스트 114개 무접촉이 회귀 게이트.

## 격리 구조

- `experiments/langchain/` — 자체 package.json/node_modules (루트 zero-dep 불변, node_modules는 기존 .gitignore 커버)
- 산출물(.lc-store.json, .lc-checkpoint.db)은 로컬 gitignore

## API 실측 결과 (스모크 — smoke*.mjs 보존)

| 기능 | 확정 API | 비고 |
|------|---------|------|
| 채팅 스트리밍 | `@langchain/ollama` ChatOllama + LangGraph `streamMode: 'messages'` | 토큰 단위 수신 확인 |
| 임베딩 | OllamaEmbeddings.embedDocuments | 768차원 |
| 청킹 | `@langchain/textsplitters` RecursiveCharacterTextSplitter.fromLanguage('markdown') | |
| 벡터 검색 | `@langchain/classic` MemoryVectorStore.similaritySearchWithScore | 코사인 점수 |
| 세션 영속화 | `@langchain/langgraph-checkpoint-sqlite` SqliteSaver + thread_id | 재실행 복원 확인 |
| 요약 압축 | LangGraph 조건 노드 + RemoveMessage | 표준 패턴 |
| capture 추출 | ChatOllama.withStructuredOutput(zod) | category는 z.enum으로 강제 (자유 문자열 실측됨) |

주의: langchain v1 본체는 얇아졌고 구 경로(`langchain/vectorstores/memory`) 제거 — classic/textsplitters 분리 패키지 사용.

## 파일 계획

| 파일 | 내용 |
|------|------|
| `experiments/langchain/src/graph.mjs` | StateGraph(messages+summary) — model 노드(RAG 주입) + 조건부 summarize 노드(RemoveMessage) + SqliteSaver |
| `experiments/langchain/src/rag.mjs` | md 스캔→splitter→MemoryVectorStore, memoryVectors JSON 저장/로드, retriever(topK 4·minScore 0.35) |
| `experiments/langchain/src/capture.mjs` | withStructuredOutput(z.enum 카테고리) → novelty(similaritySearchWithScore < 0.75) → md 저장 + addDocuments(즉시 novelty 갱신) |
| `experiments/langchain/src/main.mjs` | CLI REPL — /exit /clear /index /capture (엔진과 동일 UX) |
| `dev-wiki/knowledge/langchain-comparison.md` | 비교 문서 (Phase 3 산출) |

## 패리티 매핑 및 의도적 차이

- 트리밍 기준: 엔진=토큰 추정, LC판=메시지 수(MAX 20, 최근 8 유지) — LangGraph 표준 패턴 준수, 비교 문서에 명시
- `/clear`: 엔진=파일 삭제, LC판=새 thread_id 전환 — checkpointer 모델의 자연스러운 방식, 비교 포인트
- capture novelty 갱신: 엔진=전체 재인덱싱, LC판=addDocuments 증분 — 비교 포인트

## AC

- [ ] AC1: LC판 CLI에서 스트리밍 대화 + 재실행 시 체크포인트 복원
- [ ] AC2: `/index` 후 문서 기반 답변 (RAG)
- [ ] AC3: `/capture` 저장 → 재캡처 스킵 (novelty 루프)
- [ ] AC4: 본 엔진 `npm test` 114 passed 불변 (격리 확인)
- [ ] AC5: 비교 문서 — 코드량 실측 + 관점 4종(추상화 이득/제어권/교체 용이성/디버깅) 정리

## Rollback

`experiments/langchain/` 삭제 + 비교 문서 삭제 — 엔진 무접촉 완전 가역.
