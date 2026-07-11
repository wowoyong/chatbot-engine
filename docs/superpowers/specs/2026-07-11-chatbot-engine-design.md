# Chatbot Engine — 설계 문서

- 날짜: 2026-07-11
- 상태: 사용자 승인 완료 (브레인스토밍 세션)
- 목적: 개발 공부용 학습 프로젝트

## 목표

Qwen3 8B(로컬 Ollama) 기반 대화형 챗봇 엔진을 **프레임워크 없이 밑바닥부터** TypeScript로 구현한다.
엔진 레포를 OpenWiki로 자동 문서화하여 별도 wiki 레포에 저장하고,
그 wiki를 챗봇이 RAG로 습득하여 "자기 자신에 대해 답할 수 있는 챗봇"을 완성한다.
이후 동일 기능을 LangChain으로 재구현하여 비교 학습한다.

## 확정된 결정 사항

| 항목 | 결정 |
|------|------|
| wiki 역할 | 둘 다 — OpenWiki가 엔진 레포 문서화 + 챗봇이 그 wiki를 RAG 소스로 사용 |
| 구현 레벨 | 밑바닥부터 직접 (Ollama HTTP API를 fetch로 직접 호출, 프레임워크 없음) |
| 언어/런타임 | TypeScript + 로컬 Ollama (qwen3:8b) |
| 인터페이스 | CLI REPL 먼저 → 이후 Phase에서 웹 UI/API |
| 후속 계획 | LangChain/LangGraph 재구현 비교 (Phase 6) |

## 레포 구성

```
chatbot-engine/          ← 이 레포 (TypeScript)
├── src/
│   ├── llm/            LlmClient — Ollama HTTP API 어댑터 (인터페이스로 분리)
│   ├── chat/           ChatSession — 대화 루프, 멀티턴 히스토리
│   ├── context/        ContextManager — 토큰 카운팅, 트리밍/요약
│   ├── rag/            Retriever — 청킹, 임베딩, 코사인 유사도 검색
│   └── cli/            REPL 인터페이스
└── CLAUDE.md / AGENTS.md   ← OpenWiki가 wiki 참조를 삽입

chatbot-engine-wiki/     ← 별도 레포: OpenWiki 산출물 (md 문서)
```

OpenWiki는 기본적으로 wiki를 같은 레포에 커밋하므로, 산출물을 wiki 레포로 push하는
sync 스텝(GitHub Action)을 직접 구성한다.

## Phase 로드맵

| Phase | 내용 | 학습 포인트 |
|-------|------|------------|
| 0 | 환경: `ollama pull qwen3:8b` + TS 프로젝트 스캐폴딩 | — |
| 1 | 코어 엔진: `/api/chat` fetch 직접 호출, 대화 루프, 멀티턴 히스토리, 스트리밍(ndjson 파싱), CLI REPL | LLM API wire format, 스트리밍 원리 |
| 2 | 메모리/컨텍스트: 토큰 카운팅, 초과 시 트리밍·요약, 세션 영속화(JSON→SQLite) | 컨텍스트 윈도우 관리 |
| 3 | RAG 직접 구현: md 청킹 → 임베딩(`nomic-embed-text`) → in-memory 코사인 유사도 검색 → 프롬프트 주입 | 임베딩/시맨틱 검색 원리 |
| 4 | OpenWiki 연동: `openwiki --init` 문서화 → wiki 레포 sync → 챗봇이 자기 wiki를 RAG로 습득 | 문서 자동화 파이프라인 |
| 5 | API 서버 + 웹 UI | 엔진/인터페이스 분리 |
| 6 | LangChain/LangGraph 재구현 비교 | 프레임워크 추상화의 실체 |

## 핵심 설계 원칙

1. **LlmClient 인터페이스 분리** — provider 교체(LangChain 전환, 다른 모델)에도 엔진 코드가 불변이어야 함. 이 프로젝트의 가장 중요한 경계선.
2. **의존성 최소** — Phase 1~3은 fetch + Node 표준 라이브러리로 구현. 벡터 저장도 처음엔 배열 + 코사인 유사도 (수백 문서 규모에 충분).
3. **Phase별 독립 학습 단위** — 각 Phase는 단독으로 완결되고 테스트 가능해야 함.

## 미확인 리스크

- **[미확인]** OpenWiki의 로컬 Ollama provider 지원 여부. Ollama의 OpenAI 호환 endpoint
  (`localhost:11434/v1`) 지정으로 가능할 것으로 추정. 불가 시 wiki 생성만 클라우드 모델
  (OpenRouter 등) 사용 fallback. 8B 모델의 대량 문서화 품질 한계로 클라우드 모델이 현실적일 수 있음.

## 테스트 방침

- 각 Phase의 핵심 로직(히스토리 관리, 트리밍, 청킹, 코사인 유사도)은 Vitest 단위 테스트 동반.
- Ollama 호출은 mocking — CI에서 실제 모델 없이 실행 가능해야 함.
- 정상/에러/경계값 케이스 최소 3케이스 기준 적용.
