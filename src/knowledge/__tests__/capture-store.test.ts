import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoveltyVerdict } from '../novelty.js';
import { listCaptured, saveCaptured, slugify } from '../capture-store.js';

function verdict(title: string, maxScore = 0.123): NoveltyVerdict {
  return {
    candidate: { title, category: 'fact', content: `${title}에 대한 내용` },
    maxScore,
    isNew: true,
  };
}

describe('slugify', () => {
  it('한글은 보존하고 특수문자·공백은 하이픈으로 바꾼다 (정상)', () => {
    expect(slugify('Ollama의 기본 num_ctx는 4096!')).toBe('ollama의-기본-num-ctx는-4096');
  });

  it('의미 있는 문자가 없으면 knowledge로 대체한다 (경계값)', () => {
    expect(slugify('!!! ***')).toBe('knowledge');
    expect(slugify('')).toBe('knowledge');
  });
});

describe('saveCaptured', () => {
  let dir: string;

  beforeEach(() => {
    dir = join('.test-tmp', randomUUID());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('카테고리 디렉토리에 제목·내용·메타를 담아 저장한다 (정상)', async () => {
    const path = await saveCaptured(dir, verdict('테스트 지식'), '2026-07-11');
    expect(path).toBe(join(dir, 'fact', '테스트-지식.md'));

    const body = await readFile(path, 'utf8');
    expect(body).toContain('# 테스트 지식');
    expect(body).toContain('테스트 지식에 대한 내용');
    expect(body).toContain('수집: 2026-07-11 · 분류: fact · novelty 최고 유사도: 0.123');
  });

  it('같은 제목이 이미 있으면 -2, -3을 붙인다 (경계값)', async () => {
    const p1 = await saveCaptured(dir, verdict('중복'), 't');
    const p2 = await saveCaptured(dir, verdict('중복'), 't');
    const p3 = await saveCaptured(dir, verdict('중복'), 't');
    expect(p1).toBe(join(dir, 'fact', '중복.md'));
    expect(p2).toBe(join(dir, 'fact', '중복-2.md'));
    expect(p3).toBe(join(dir, 'fact', '중복-3.md'));
  });

  it('디렉토리가 없어도 자동 생성된다 — writeFileAtomic 경유 (경계값)', async () => {
    const path = await saveCaptured(join(dir, 'deep'), verdict('중첩'), 't');
    expect(await readFile(path, 'utf8')).toContain('# 중첩');
  });

  it('listCaptured가 카테고리별 저장 지식을 제목과 함께 반환한다 (정상)', async () => {
    await saveCaptured(dir, verdict('첫 지식'), 't');
    const entries = await listCaptured(dir);
    expect(entries).toHaveLength(1);
    expect(entries.at(0)).toMatchObject({ title: '첫 지식', category: 'fact' });
  });

  it('디렉토리가 없으면 빈 배열 (경계값)', async () => {
    expect(await listCaptured(join(dir, 'none'))).toEqual([]);
  });
});
