import { describe, expect, it } from 'vitest';
import type { IndexedChunk } from '../vector-index.js';
import { Bm25Index, idf, tokenize } from '../bm25.js';

function chunk(source: string, content: string): IndexedChunk {
  return { source, heading: '', content, embedding: [] };
}

describe('tokenize', () => {
  it('한글·영문·숫자 런으로 나누고 특수문자를 버린다 (정상)', () => {
    expect(tokenize('Ollama의 num_ctx는 4096!')).toEqual(['ollama의', 'num', 'ctx는', '4096']);
  });

  it('빈 문자열은 빈 배열 (경계값)', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!! @#$')).toEqual([]);
  });
});

describe('idf', () => {
  it('흔한 단어일수록 IDF가 낮다 (정상)', () => {
    expect(idf(100, 1)).toBeGreaterThan(idf(100, 50));
  });
});

describe('Bm25Index', () => {
  const docs = [
    chunk('a.md', '양자화 모델 메모리 줄인다'),
    chunk('b.md', '임베딩 텍스트 벡터 바꾼다'),
    chunk('c.md', '청킹 문서 조각 나눈다'),
  ];

  it('질의 키워드가 담긴 문서를 상위로 반환한다 (정상)', () => {
    const index = new Bm25Index(docs);
    const hits = index.search('양자화 메모리', 3);
    expect(hits.at(0)?.chunk.source).toBe('a.md');
    expect(hits.at(0)?.score).toBeGreaterThan(0);
  });

  it('질의 단어가 어느 문서에도 없으면 빈 결과 (에러/경계)', () => {
    const index = new Bm25Index(docs);
    expect(index.search('블록체인 채굴', 3)).toEqual([]);
  });

  it('빈 인덱스는 항상 빈 결과 (경계값)', () => {
    const index = new Bm25Index([]);
    expect(index.size).toBe(0);
    expect(index.search('아무거나', 3)).toEqual([]);
  });

  it('topK로 결과 수를 제한한다 (경계값)', () => {
    const many = [
      chunk('1.md', '검색 검색'),
      chunk('2.md', '검색'),
      chunk('3.md', '검색'),
    ];
    expect(new Bm25Index(many).search('검색', 2)).toHaveLength(2);
  });
});
