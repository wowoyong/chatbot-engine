import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../llm/types.js';
import { buildChatMlPrompt } from '../chat-template.js';
import { sampleToken } from '../sampler.js';
import { NativeLlmClient } from '../native-client.js';
import { BpeTokenizer } from '../../tokenizer/bpe.js';
import { bytesToUnicode } from '../../tokenizer/bytes.js';
import type { TransformerModel } from '../../transformer/model.js';

describe('sampleToken', () => {
  it('temperature 0이면 argmax를 반환한다 (정상)', () => {
    expect(sampleToken(new Float32Array([0.1, 5, 0.2]), {})).toBe(1);
  });

  it('rng 주입으로 확률 경로가 결정적이다 (경계값)', () => {
    // 두 토큰 동일 확률, rng=0 → 첫 keep 반환
    const id = sampleToken(new Float32Array([1, 1]), { temperature: 1 }, () => 0);
    expect([0, 1]).toContain(id);
  });
});

describe('buildChatMlPrompt', () => {
  it('ChatML 규격으로 조립하고 assistant로 끝난다 (정상)', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: '안녕' }];
    const p = buildChatMlPrompt(msgs, 'SYS');
    expect(p).toBe('<|im_start|>system\nSYS<|im_end|>\n<|im_start|>user\n안녕<|im_end|>\n<|im_start|>assistant\n');
  });
});

/** byte vocab + 몇 토큰으로 소형 토크나이저 */
function tinyTokenizer(): BpeTokenizer {
  const enc = bytesToUnicode();
  const tokens = [...enc.values(), '<|im_end|>'];
  const tokenType = tokens.map((_, i) => (i === tokens.length - 1 ? 3 : 1));
  return new BpeTokenizer({ tokens, merges: [], tokenType });
}

/** 입력 토큰 → 다음 토큰 매핑 기반 Fake (prefill 호출 수와 무관). 매핑 없으면 defaultNext */
class FakeTransformer {
  readonly forwardCalls: number[] = [];
  private vocab = 300;
  constructor(
    private readonly nextOf: Map<number, number>,
    private readonly defaultNext: number,
  ) {}
  get hyperparams() {
    return { vocabSize: this.vocab } as never;
  }
  forward(tokenId: number, _pos: number): Float32Array {
    this.forwardCalls.push(tokenId);
    const logits = new Float32Array(this.vocab);
    const target = this.nextOf.get(tokenId) ?? this.defaultNext;
    logits[target] = 100; // argmax = target
    return logits;
  }
}

async function collect(gen: AsyncGenerator<string, unknown>): Promise<{ text: string; ret: unknown }> {
  let text = '';
  let r = await gen.next();
  while (r.done !== true) {
    text += r.value;
    r = await gen.next();
  }
  return { text, ret: r.value };
}

describe('NativeLlmClient', () => {
  it('prefill 후 생성하고 eos에서 정지한다 (정상)', async () => {
    const tok = tinyTokenizer();
    const eosId = tok.tokenId('<|im_end|>')!;
    // 'h' 토큰 id
    const hId = tok.encode('h')[0]!;
    // 마지막 prefill logits → hId(gen1='h'), forward('h') → eos → 정지
    const fake = new FakeTransformer(new Map([[hId, eosId]]), hId) as unknown as TransformerModel;
    const client = new NativeLlmClient(fake, tok, { maxTokens: 10, eosTokenId: eosId });
    const { text, ret } = await collect(client.chatStream([{ role: 'user', content: 'x' }]));
    expect(text).toBe('h');
    expect((ret as { responseTokens?: number }).responseTokens).toBe(1);
  });

  it('maxTokens 상한에서 정지한다 (경계값)', async () => {
    const tok = tinyTokenizer();
    const aId = tok.encode('a')[0]!;
    const fake = new FakeTransformer(new Map(), aId) as unknown as TransformerModel; // 항상 'a'
    const client = new NativeLlmClient(fake, tok, { maxTokens: 3, eosTokenId: 999999 });
    const { text } = await collect(client.chatStream([{ role: 'user', content: 'x' }]));
    expect(text).toBe('aaa'); // 3개 상한
  });
});
