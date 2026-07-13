import { bytesToUnicode, unicodeToBytes } from './bytes.js';

/** GPT-2/qwen2 계열 pretokenizer 정규식 (JS 호환) */
const PRETOKEN_RE =
  /(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface TokenizerConfig {
  tokens: string[];
  merges: string[];
  /** token_type 배열 (1=normal, 3=control) */
  tokenType?: number[];
}

export class BpeTokenizer {
  private readonly tokenToId = new Map<string, number>();
  private readonly idToToken: string[];
  private readonly mergeRanks = new Map<string, number>();
  private readonly byteEncoder = bytesToUnicode();
  private readonly byteDecoder = unicodeToBytes();
  private readonly specialTokens: string[];
  private readonly specialRe: RegExp | null;

  constructor(config: TokenizerConfig) {
    this.idToToken = config.tokens;
    for (let i = 0; i < config.tokens.length; i += 1) {
      const tok = config.tokens[i];
      if (tok !== undefined) this.tokenToId.set(tok, i);
    }
    for (let i = 0; i < config.merges.length; i += 1) {
      const m = config.merges[i];
      if (m !== undefined) this.mergeRanks.set(m, i);
    }
    // control 타입 토큰을 특수토큰으로 (선분리 대상)
    this.specialTokens = [];
    if (config.tokenType !== undefined) {
      for (let i = 0; i < config.tokens.length; i += 1) {
        if (config.tokenType[i] === 3) {
          const tok = config.tokens[i];
          if (tok !== undefined) this.specialTokens.push(tok);
        }
      }
    }
    this.specialRe =
      this.specialTokens.length > 0
        ? new RegExp(`(${this.specialTokens.map(escapeRegex).join('|')})`)
        : null;
  }

  /** 문자열을 (일반|특수) 조각으로 분리 */
  private splitSpecial(text: string): { text: string; special: boolean }[] {
    if (this.specialRe === null) {
      return [{ text, special: false }];
    }
    const out: { text: string; special: boolean }[] = [];
    for (const part of text.split(this.specialRe)) {
      if (part.length === 0) continue;
      out.push({ text: part, special: this.specialTokens.includes(part) });
    }
    return out;
  }

  /** byte-encoded 문자열에 merge를 반복 적용해 토큰 배열 반환 */
  private bpe(token: string): string[] {
    let word = Array.from(token);
    if (word.length < 2) return word;
    while (word.length >= 2) {
      let minRank = Infinity;
      let minIdx = -1;
      for (let i = 0; i < word.length - 1; i += 1) {
        const rank = this.mergeRanks.get(`${word[i]} ${word[i + 1]}`);
        if (rank !== undefined && rank < minRank) {
          minRank = rank;
          minIdx = i;
        }
      }
      if (minIdx === -1) break;
      word = [
        ...word.slice(0, minIdx),
        `${word[minIdx]}${word[minIdx + 1]}`,
        ...word.slice(minIdx + 2),
      ];
    }
    return word;
  }

  /** 텍스트 → 토큰 ID 배열 */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const seg of this.splitSpecial(text)) {
      if (seg.special) {
        const id = this.tokenToId.get(seg.text);
        if (id !== undefined) ids.push(id);
        continue;
      }
      for (const match of seg.text.matchAll(PRETOKEN_RE)) {
        const piece = match[0];
        const bytes = Buffer.from(piece, 'utf8');
        let encoded = '';
        for (const b of bytes) {
          encoded += this.byteEncoder.get(b) ?? '';
        }
        for (const tok of this.bpe(encoded)) {
          const id = this.tokenToId.get(tok);
          if (id !== undefined) ids.push(id);
        }
      }
    }
    return ids;
  }

  /** 토큰 ID 배열 → 텍스트 (control 특수토큰은 skip) */
  decode(ids: readonly number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      const tok = this.idToToken[id];
      if (tok === undefined) continue;
      if (this.specialTokens.includes(tok)) continue; // 특수토큰 skip
      for (const ch of tok) {
        const b = this.byteDecoder.get(ch);
        if (b !== undefined) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }

  tokenId(token: string): number | undefined {
    return this.tokenToId.get(token);
  }
}
