export interface GoldenQuestion {
  question: string;
  /** 정답이 담긴 corpus 파일명 */
  expectedSource: string;
}

export const GOLDEN_QUESTIONS: GoldenQuestion[] = [
  { question: '토큰이 뭐야? 영어랑 한국어 토큰 효율이 어떻게 달라?', expectedSource: 'llm-basics.md' },
  { question: '컨텍스트 윈도우가 뭐고 왜 관리해야 해?', expectedSource: 'llm-basics.md' },
  { question: 'temperature 파라미터는 무슨 역할이야?', expectedSource: 'llm-basics.md' },
  { question: 'LLM은 왜 stateless라고 해?', expectedSource: 'llm-basics.md' },
  { question: '챗봇의 최소 구성 요소는 뭐가 있어?', expectedSource: 'chatbot-architecture.md' },
  { question: '스트림이 중간에 끊기면 히스토리를 어떻게 처리해?', expectedSource: 'chatbot-architecture.md' },
  { question: '요약 압축으로 메모리를 관리하는 방법은?', expectedSource: 'chatbot-architecture.md' },
  { question: '임베딩이 뭐고 색인이랑 질의에 같은 모델을 써야 하는 이유는?', expectedSource: 'rag.md' },
  { question: '청킹할 때 겹침을 두는 이유가 뭐야?', expectedSource: 'rag.md' },
  { question: '하이브리드 검색이 왜 필요해?', expectedSource: 'rag.md' },
  { question: 'top-K랑 최소 유사도 임계값은 무슨 역할이야?', expectedSource: 'rag.md' },
  { question: '16GB 메모리에서 14b 모델을 못 돌리는 이유가 뭐야?', expectedSource: 'local-llm-serving.md' },
  { question: '양자화가 뭐고 메모리를 얼마나 줄여줘?', expectedSource: 'local-llm-serving.md' },
  { question: 'Ollama의 OpenAI 호환 API는 어떻게 써?', expectedSource: 'local-llm-serving.md' },
  { question: '시스템 프롬프트를 작성할 때 소형 모델 주의점은?', expectedSource: 'prompt-engineering.md' },
  { question: 'RAG 발췌를 프롬프트에 넣을 때 출처 인용을 유도하는 방법은?', expectedSource: 'prompt-engineering.md' },
  { question: 'LangGraph는 뭐고 언제 써?', expectedSource: 'langchain-overview.md' },
  { question: 'DeepAgents가 뭐야?', expectedSource: 'langchain-overview.md' },
  { question: '밑바닥 구현과 LangChain의 코드량 차이가 얼마나 나?', expectedSource: 'langchain-comparison.md' },
  { question: '구조화 출력은 어떤 오류를 없애고 어떤 건 못 없애?', expectedSource: 'langchain-comparison.md' },
];
