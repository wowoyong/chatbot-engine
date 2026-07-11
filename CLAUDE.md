# chatbot-engine

Qwen3 8B(로컬 Ollama) 기반 대화형 챗봇 엔진 — 프레임워크 없이 밑바닥부터 구현하는 학습 프로젝트.
설계 문서: `docs/superpowers/specs/2026-07-11-chatbot-engine-design.md`

## 명령어

- `npm run dev` — CLI REPL 실행 (로컬 Ollama + qwen3:8b 필요)
- `npm test` — 단위 테스트 (Ollama 불필요 — fetch mock)
- `npm run typecheck` — 타입 검사 (테스트 포함)
- `npm run build` — dist/ 산출 (테스트 제외)

## 컨벤션

- ESM (NodeNext) — 상대 import에 `.js` 확장자 필수
- `any` 금지 — `unknown` + 타입 가드
- 런타임 의존성 0개 유지 (Segment 1~3 동안)
- 테스트 위치: `src/**/__tests__/<파일명>.test.ts` (Vitest)
- LLM 호출 경계는 `src/llm/types.ts`의 `LlmClient` 인터페이스를 통해서만
- 세션 자동 저장: `.chatbot/session.json` (env `CHATBOT_SESSION_FILE`로 변경 가능)
- RAG: `/index`로 `docs/` 인덱싱 (`.chatbot/rag-index.json`, env `RAG_DOCS_DIR`/`CHATBOT_INDEX_FILE`)

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
- wiki 갱신: `OPENWIKI_PROVIDER=openai-compatible OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 OPENAI_COMPATIBLE_API_KEY=ollama OPENWIKI_MODEL_ID=qwen3:8b npx -y openwiki code --update` → `npm run sync-wiki` (별도 레포 ../chatbot-engine-wiki로 반영)
- 챗봇의 wiki 습득: `RAG_DOCS_DIR=../chatbot-engine-wiki CHATBOT_INDEX_FILE=.chatbot/wiki-index.json npm run dev` 후 `/index`
