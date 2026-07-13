import { describe, expect, it } from 'vitest';
import { bytesToUnicode, unicodeToBytes } from '../bytes.js';
import { BpeTokenizer } from '../bpe.js';

describe('bytesToUnicode', () => {
  it('256 바이트를 유일 유니코드로 매핑한다 (정상)', () => {
    const map = bytesToUnicode();
    expect(map.size).toBe(256);
    expect(new Set(map.values()).size).toBe(256);
  });

  it('역매핑이 왕복한다 (경계값)', () => {
    const fwd = bytesToUnicode();
    const rev = unicodeToBytes();
    for (const [b, ch] of fwd) expect(rev.get(ch)).toBe(b);
  });
});

/** 소형 vocab: byte 문자 전부 + 병합 몇 개 */
function smallTokenizer(): BpeTokenizer {
  const enc = bytesToUnicode();
  const tokens: string[] = [...enc.values()]; // 256 byte 문자
  const merges: string[] = [];
  // "hi" 병합 예시: h(byte) i(byte) 는 자기자신 문자 — merge "h i" 추가
  const h = enc.get('h'.charCodeAt(0))!;
  const i = enc.get('i'.charCodeAt(0))!;
  merges.push(`${h} ${i}`);
  tokens.push(`${h}${i}`); // 병합 토큰 = id 256
  // 특수토큰
  const special = '<|im_end|>';
  tokens.push(special); // id 257
  const tokenType = tokens.map((_, idx) => (idx === tokens.length - 1 ? 3 : 1));
  return new BpeTokenizer({ tokens, merges, tokenType });
}

describe('BpeTokenizer', () => {
  it('영어 왕복이 원문과 일치한다 (정상)', () => {
    const t = smallTokenizer();
    expect(t.decode(t.encode('hi there'))).toBe('hi there');
  });

  it('한글(멀티바이트) 왕복이 원문과 일치한다 (정상)', () => {
    const t = smallTokenizer();
    expect(t.decode(t.encode('안녕하세요'))).toBe('안녕하세요');
  });

  it('merge가 적용되어 "hi"가 단일 토큰이 된다 (정상)', () => {
    const t = smallTokenizer();
    const ids = t.encode('hi');
    expect(ids).toHaveLength(1); // 병합됨
  });

  it('특수토큰은 단일 ID로 encode되고 decode 시 skip된다 (경계값)', () => {
    const t = smallTokenizer();
    const ids = t.encode('a<|im_end|>b');
    expect(ids).toContain(t.tokenId('<|im_end|>'));
    expect(t.decode(ids)).toBe('ab'); // 특수토큰 skip
  });

  it('빈 문자열은 빈 배열 (경계값)', () => {
    const t = smallTokenizer();
    expect(t.encode('')).toEqual([]);
    expect(t.decode([])).toBe('');
  });
});
