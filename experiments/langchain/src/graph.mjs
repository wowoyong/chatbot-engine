import {
  HumanMessage,
  RemoveMessage,
  SystemMessage,
} from '@langchain/core/messages';
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

const SYSTEM_PROMPT = '당신은 간결하고 정확하게 답하는 한국어 어시스턴트입니다.';
// 엔진은 토큰 추정 기반 예산 — LC판은 LangGraph 표준 패턴대로 메시지 수 기준 (비교 문서에 명시)
const MAX_MESSAGES = 20;
const KEEP_RECENT = 8;

export function createGraph({ model, retriever, dbPath }) {
  const State = Annotation.Root({
    ...MessagesAnnotation.spec,
    summary: Annotation({ reducer: (_prev, next) => next, default: () => '' }),
  });

  async function callModel(state) {
    const prefix = [new SystemMessage(SYSTEM_PROMPT)];
    if (state.summary) {
      prefix.push(new SystemMessage(`이전 대화 요약: ${state.summary}`));
    }
    if (retriever) {
      const last = state.messages.at(-1);
      const block = await retriever.retrieve(String(last?.content ?? ''));
      if (block) {
        prefix.push(new SystemMessage(block));
      }
    }
    const response = await model.invoke([...prefix, ...state.messages]);
    return { messages: [response] };
  }

  async function summarize(state) {
    const overflow = state.messages.slice(0, -KEEP_RECENT);
    const text = overflow.map((m) => `${m.getType()}: ${m.content}`).join('\n');
    const res = await model.invoke([
      new SystemMessage(
        '다음 대화를 이후 대화의 문맥으로 쓸 수 있게 한국어 한 문단으로 요약하라. 사실·선호·결정 사항을 우선 보존하라.',
      ),
      new HumanMessage(
        state.summary ? `기존 요약: ${state.summary}\n\n추가 대화:\n${text}` : text,
      ),
    ]);
    return {
      summary: String(res.content),
      messages: overflow.map((m) => new RemoveMessage({ id: m.id })),
    };
  }

  function shouldSummarize(state) {
    return state.messages.length > MAX_MESSAGES ? 'summarize' : END;
  }

  return new StateGraph(State)
    .addNode('model', callModel)
    .addNode('summarize', summarize)
    .addEdge(START, 'model')
    .addConditionalEdges('model', shouldSummarize)
    .addEdge('summarize', END)
    .compile({ checkpointer: SqliteSaver.fromConnString(dbPath) });
}
