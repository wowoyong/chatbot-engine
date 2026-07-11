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
