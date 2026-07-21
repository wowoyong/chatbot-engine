# chatbot-engine

로컬 LLM(Qwen3 8B / Ollama) 기반 대화형 챗봇 엔진을 **프레임워크 없이 밑바닥부터** 구현한 학습 프로젝트. 스트리밍 대화·컨텍스트 메모리 관리·RAG·대화형 지식 축적을 순수 TypeScript로 만들고, 같은 기능을 LangChain으로 재구현해 비교했다.

- **런타임 의존성 0개** — `fetch`·스트림·`node:http` 등 Node 20 표준 라이브러리만 사용 (개발 의존성은 TypeScript·Vitest·tsx뿐)
- **179개 단위 테스트** — LLM 호출을 mock 처리해 Ollama 없이 CI에서 실행 가능
- **엔진 / 인터페이스 분리** — 하나의 코어 엔진을 CLI와 웹 서버가 공유
- **자체 LLM 추론 엔진** — Qwen2.5-0.5B의 트랜스포머 forward pass(GGUF 로더·BPE 토크나이저·GQA 어텐션·SwiGLU)를 순수 TS로 밑바닥 구현. Ollama와 argmax 일치 검증 (`src/gguf`·`src/tokenizer`·`src/transformer`·`src/native`)

> 회사 업무와 무관한 개인 학습 프로젝트입니다. LLM 애플리케이션의 내부 동작(스트리밍 파싱, 컨텍스트 예산, 임베딩 검색)을 프레임워크에 감추지 않고 직접 구현해 이해하는 것이 목표입니다.

## 무엇을 할 수 있나

- 로컬 모델과 **토큰 단위 스트리밍** 대화 (CLI 또는 웹 UI)
- 대화가 길어지면 오래된 내용을 **LLM 요약으로 압축**해 컨텍스트 예산 관리
- 세션 **자동 저장/복원** — 재시작해도 대화가 이어짐
- 문서를 인덱싱해 **RAG**로 근거 기반 답변 (출처 인용)
- 대화에서 **새 지식만 골라 저장**하고 재인덱싱 (자기참조 지식 루프)

## 빠른 시작

```bash
# 사전 준비: Ollama 설치 후 모델 받기
ollama pull qwen3:8b
ollama pull nomic-embed-text        # RAG 임베딩용

npm install
npm test                            # 114개 테스트 (Ollama 불필요)

npm run dev                         # CLI REPL
npm run serve                       # 웹 UI (http://127.0.0.1:3000)
```

CLI/웹 명령: `/index` 문서 인덱싱 · `/capture` 대화에서 draft 지식 저장 · `/captured` 검토 목록 · `/approve N` 승인 · `/clear` 초기화 · `/exit`

## Repository knowledge

- 시작점: `openwiki/quickstart.md`
- 무결성 검사: `npm run wiki:check`
- 운영과 같은 retrieval 평가: `npm run eval:wiki` (Ollama 필요)
- 신규 대화 지식: draft 저장 → CLI/Web 승인 → verified 검색 노출

## 아키텍처

메시지 한 턴이 흐르는 경로 — LLM은 stateless이고, "기억"처럼 보이는 모든 것은 매 턴 재조립된다:

```
사용자 입력
   │
   ▼  ChatSession
 ① RAG 검색 (Retriever)      질문을 임베딩 → 벡터 유사도 검색 → 관련 문서 발췌
   │
 ② 컨텍스트 조립             [시스템, 발췌, 요약, 최근 히스토리, 질문]을 예산에 맞게 구성
   │  (ContextManager)        초과 시 오래된 대화를 트리밍 + LLM 요약으로 압축
   ▼
 ③ LLM 호출 (OllamaClient)   POST /api/chat (stream) → ndjson 스트림
   │
 ④ ndjson 파서               청크 경계·멀티바이트를 버퍼링해 토큰 조각 복원
   │
 ⑤ 출력 + 기록               조각을 즉시 렌더 → 완주 시에만 히스토리 저장(원자적 쓰기)
```

핵심 설계 결정:

| 결정 | 이유 |
|------|------|
| `LlmClient`·`Embedder` **인터페이스 경계** | 모델·구현체 교체가 엔진 코드에 영향 없음 (LangChain 전환도 이 경계로 흡수) |
| 스트림 **실패 시 히스토리 미기록** | 반쪽 응답이 다음 턴 컨텍스트를 오염시키는 것 방지 |
| 트리밍·요약은 **전송본에만**, 원본 보존 | 히스토리 원본 무손실 — 언제든 재구성 가능 |
| 우아한 성능 저하 (**3중 fallback**) | 검색 실패→발췌 없이 / 요약 실패→트리밍만 / 파일 손상→백업 후 새 세션 |
| **원자적 파일 쓰기** (tmp→rename) | 쓰기 중 크래시에도 세션·인덱스 무손상 |

## 모듈 구성 (`src/`)

| 디렉토리 | 역할 |
|----------|------|
| `llm/` | Ollama HTTP 클라이언트, ndjson 스트리밍 파서, 임베더, 인터페이스 정의 |
| `chat/` | 멀티턴 세션 — 히스토리 재조립·기록 |
| `context/` | 토큰 추정, 쌍 단위 트리밍, LLM 요약 압축 |
| `rag/` | 마크다운 청킹, 코사인 유사도, 인메모리 벡터 인덱스, 검색기 |
| `store/` | 세션 JSON 영속화, 원자적 파일 쓰기 |
| `knowledge/` | 대화 지식 추출, novelty 판정, 카테고리별 저장 |
| `app/` | CLI·서버 공용 조립(bootstrap) |
| `server/` | node:http SSE 서버 + 바닐라 웹 UI |

## 개발 과정에서 배운 것 (실측)

이 프로젝트는 설계 문서 → 상세 계획서 → 구현 → 검증의 반복으로 진행했고(`docs/plans/`), 실행 과정에서 얻은 관찰들:

- **RAG의 "관련 ≠ 정답"**: 임베딩 유사도는 주제 유사성이지 정답 포함 여부가 아니다. 자기유사한 문서가 많은 코퍼스에서 정답 청크가 상위에서 밀리는 것을 관찰 → 하이브리드 검색(BM25+벡터) 필요성 도출 (`docs/ROADMAP.md`).
- **임베딩 유사도의 기준선**: nomic-embed-text 공간에서 *무관한 한국어 문장끼리도* 유사도 0.77~0.87이 나온다. novelty 중복 판정 임계값을 0.75→0.95로 보정 (중복은 0.96+). LangChain 재구현으로 같은 기능을 두 번 만들며 교차 검증하다 발견.
- **구조화 출력의 한계**: JSON 스키마 강제는 *형식* 오류를 없애지만 *내용* 오류(모델이 엉뚱한 걸 추출)는 못 없앤다.

전체 비교 회고: [밑바닥 구현 vs LangChain](https://github.com/wowoyong/dev-wiki/blob/main/knowledge/langchain-comparison.md)

## Agent-readable wiki

`openwiki/`는 OpenWiki 0.2.1이 생성하는 canonical OKF v0.1 bundle이다. GitHub Actions가 변경 PR을 만들며 generated page는 직접 수정하지 않는다. 로컬 생성은 Node 22에서 `npx -y openwiki@0.2.1 code --update --print`를 사용한다. `npm run wiki:check`로 구조와 링크를 검증하며, `npm run sync-wiki`는 선택적으로 generated bundle을 `dev-wiki`에 mirror한다.

## LangChain 비교 (`experiments/langchain/`)

같은 전기능을 LangChain/LangGraph로 재구현(338줄 vs 엔진 코어 1,188줄). 프레임워크가 흡수한 것(wire 처리·영속화·청킹·구조화 출력)과 여전히 직접 해야 하는 것(도메인 정책·신뢰 경계 처리)의 경계를 실측했다. 요지: *표준 부품은 프레임워크가 가져가지만, 도메인 정책은 어차피 내 몫 — 그 경계를 아는 것이 밑바닥 구현의 수확.*

## 다음 단계

`docs/ROADMAP.md` 참조 — 검색 품질(평가 세트 + 하이브리드), 웹 UI 개선, 맥미니 배포 등. 모든 항목에 실측 근거를 달아뒀다.

## 라이선스

MIT
