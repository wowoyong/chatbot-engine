import type { ChatMessage, ChatOptions, LlmClient } from '../llm/types.js';
import type { BpeTokenizer } from '../tokenizer/bpe.js';
import type { TransformerModel } from '../transformer/model.js';
import { buildChatMlPrompt } from './chat-template.js';
import { sampleToken } from './sampler.js';
import type { SampleOptions } from './sampler.js';

export interface NativeClientConfig {
  systemPrompt?: string;
  /** 최대 생성 토큰. 기본 256 */
  maxTokens?: number;
  /** 종료 토큰. 기본 151645 (<|im_end|>) */
  eosTokenId?: number;
  sample?: SampleOptions;
}

export class NativeLlmClient implements LlmClient {
  private readonly model: TransformerModel;
  private readonly tokenizer: BpeTokenizer;
  private readonly config: NativeClientConfig;

  constructor(
    model: TransformerModel,
    tokenizer: BpeTokenizer,
    config: NativeClientConfig = {},
  ) {
    this.model = model;
    this.tokenizer = tokenizer;
    this.config = config;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    let out = '';
    for await (const piece of this.chatStream(messages, options)) {
      out += piece;
    }
    return out;
  }

  async *chatStream(
    messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }> {
    const prompt = buildChatMlPrompt(messages, this.config.systemPrompt);
    const promptIds = this.tokenizer.encode(prompt);
    const eos = this.config.eosTokenId ?? 151645;
    const maxTokens = this.config.maxTokens ?? 256;

    let pos = 0;
    let logits: Float32Array | null = null;
    for (const id of promptIds) {
      logits = this.model.forward(id, pos);
      pos += 1;
    }
    if (logits === null) {
      return { promptTokens: 0, responseTokens: 0 };
    }

    const generated: number[] = [];
    let emitted = '';
    for (let step = 0; step < maxTokens; step += 1) {
      const next = sampleToken(logits, this.config.sample ?? {});
      if (next === eos) {
        break;
      }
      generated.push(next);
      const full = this.tokenizer.decode(generated);
      if (full.length > emitted.length) {
        yield full.slice(emitted.length);
        emitted = full;
      }
      logits = this.model.forward(next, pos);
      pos += 1;
    }
    return { promptTokens: promptIds.length, responseTokens: generated.length };
  }
}
