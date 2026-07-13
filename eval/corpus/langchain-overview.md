# LangChain 생태계 개요

## LangChain

LLM 애플리케이션 프레임워크. 이 프로젝트에서 밑바닥으로 직접 만든 것들의 기성품 추상화를 제공한다:

| 직접 만든 것 | LangChain 대응 |
|-------------|---------------|
| LlmClient 인터페이스 + OllamaClient | ChatModel (ChatOllama, ChatOpenAI...) |
| ChatSession 히스토리 재조립 | Memory / MessageHistory |
| ContextManager 트리밍·요약 | trim_messages, ConversationSummaryMemory |
| 청커 + 임베딩 + VectorIndex + Retriever | TextSplitter + Embeddings + VectorStore + Retriever |
| ndjson 스트리밍 파서 | .stream() 이 내부 처리 |

프레임워크의 가치는 표준 인터페이스(모델·벡터스토어 교체 용이)와 생태계 통합이고, 비용은 내부 동작의 블랙박스화다. 밑바닥을 먼저 만들어본 뒤 쓰면 "무엇을 감춰주는지" 정확히 보인다.

## LangGraph

LangChain 팀의 에이전트 오케스트레이션 프레임워크. 대화 흐름을 그래프(노드=단계, 엣지=전이)로 명시하고, 상태(state)를 노드 사이에 전달한다. 단순 체인으로 표현하기 어려운 분기·루프·중단/재개(checkpoint)가 필요할 때 쓴다. 체크포인터를 붙이면 세션 영속화도 프레임워크가 처리한다.

## DeepAgents

LangGraph 위에 구축된 "깊은 에이전트" 패턴 구현체. 장시간 작업을 위한 계획 수립, 파일시스템 도구, 서브에이전트 위임을 기본 장착한 에이전트 하네스다. OpenWiki가 이걸로 만들어졌다 — 레포를 읽고 wiki를 쓰는 문서화 에이전트.

## Segment 6에서 비교할 것

같은 기능(대화 + 메모리 + RAG)을 LangChain/LangGraph로 재구현하며 확인할 질문들:

1. 코드량과 가독성 — 추상화가 실제로 줄여주는 것과 새로 배워야 하는 것의 비율
2. 스트리밍·에러 처리의 제어권 — 직접 구현에서 세밀하게 다뤘던 부분(부분 라인, 히스토리 오염 방지)이 프레임워크에서 어떻게 처리되는가
3. 교체 용이성 — Ollama → 다른 모델, in-memory → 벡터 DB 전환 비용
4. 디버깅 경험 — 문제가 났을 때 원인이 내 코드인지 프레임워크인지 판별 비용
