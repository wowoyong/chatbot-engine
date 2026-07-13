# chatbot-engine

Qwen3 8B(로컬 Ollama) 기반 대화형 챗봇 엔진 — 프레임워크 없이 밑바닥부터 구현하는 학습 프로젝트.
설계 문서: `docs/design/2026-07-11-chatbot-engine-design.md`

## 명령어

- `npm run dev` — CLI REPL 실행 (로컬 Ollama + qwen3:8b 필요)
- `npm run serve` — 웹 UI 서버 (기본 http://127.0.0.1:3000, env HOST/PORT)
- `npm test` — 단위 테스트 (Ollama 불필요 — fetch mock)
- `npm run typecheck` — 타입 검사 (테스트 포함)
- `npm run build` — dist/ 산출 (테스트 제외)
- 자체 추론 엔진: `LLM_ENGINE=native NATIVE_GGUF_FILE=<qwen2.5-0.5b-fp16 GGUF> npm run dev` (Ollama 대신 자체 forward)

## 컨벤션

- ESM (NodeNext) — 상대 import에 `.js` 확장자 필수
- `any` 금지 — `unknown` + 타입 가드
- 런타임 의존성 0개 유지 (Segment 1~3 동안)
- 테스트 위치: `src/**/__tests__/<파일명>.test.ts` (Vitest)
- LLM 호출 경계는 `src/llm/types.ts`의 `LlmClient` 인터페이스를 통해서만
- 세션 자동 저장: `.chatbot/session.json` (env `CHATBOT_SESSION_FILE`로 변경 가능)
- RAG: `/index`로 `docs/` 인덱싱 (`.chatbot/rag-index.json`, env `RAG_DOCS_DIR`/`CHATBOT_INDEX_FILE`)
- 검색: 벡터+BM25 하이브리드(RRF). 품질 측정은 `npm run eval` (골든 세트 recall@K/MRR — 벡터 0.45/0.85/0.62 → 하이브리드 0.65/0.95/0.80)
- 지식 캡처: CLI `/capture` 또는 웹 "지식 저장" — 대화에서 새 지식만 novelty 판정 후 `<RAG_DOCS_DIR>/captured/<분류>/`에 저장 + 자동 재인덱싱, `/captured`로 저장 지식 목록 조회
- 웹 UI: 마크다운 렌더 + 출처/토큰 표시 + 응답 중단(전송 버튼 재클릭)

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
- wiki 갱신: `OPENWIKI_PROVIDER=openai-compatible OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 OPENAI_COMPATIBLE_API_KEY=ollama OPENWIKI_MODEL_ID=qwen3:8b npx -y openwiki code --update` → `npm run sync-wiki` (모노레포형 wiki `../dev-wiki/chatbot-engine/`로 반영, env `WIKI_REPO`/`WIKI_SUBDIR`)
- 챗봇의 wiki 습득: `RAG_DOCS_DIR=../dev-wiki CHATBOT_INDEX_FILE=.chatbot/wiki-index.json npm run dev` 후 `/index` (전 프로젝트 습득 — 단일 프로젝트만은 `RAG_DOCS_DIR=../dev-wiki/chatbot-engine`)
