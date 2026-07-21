import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoveltyVerdict } from '../novelty.js';
import { parseMarkdownDocument } from '../../okf/document.js';
import { approveCaptured, listCaptured, saveCaptured, slugify } from '../capture-store.js';

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

    const parsed = parseMarkdownDocument(await readFile(path, 'utf8'));
    expect(parsed.metadata).toMatchObject({
      type: 'Captured Knowledge', title: '테스트 지식', status: 'draft', category: 'fact', provenance: 'conversation',
    });
    expect(parsed.body).toContain('테스트 지식에 대한 내용');
    expect(parsed.body).toContain('novelty: 0.123');
  });

  it('같은 제목이 이미 있으면 -2, -3을 붙인다 (경계값)', async () => {
    const p1 = await saveCaptured(dir, verdict('중복'), 't');
    const p2 = await saveCaptured(dir, verdict('중복'), 't');
    const p3 = await saveCaptured(dir, verdict('중복'), 't');
    expect(p1).toBe(join(dir, 'fact', '중복.md'));
    expect(p2).toBe(join(dir, 'fact', '중복-2.md'));
    expect(p3).toBe(join(dir, 'fact', '중복-3.md'));
  });

  it('동시 저장도 서로 다른 파일을 원자적으로 예약한다', async () => {
    const paths = await Promise.all([
      saveCaptured(dir, verdict('동시'), 't1'),
      saveCaptured(dir, verdict('동시'), 't2'),
    ]);
    expect(new Set(paths).size).toBe(2);
    await expect(Promise.all(paths.map((path) => readFile(path, 'utf8')))).resolves.toHaveLength(2);
  });

  it('디렉토리가 없어도 자동 생성된다 — writeFileAtomic 경유 (경계값)', async () => {
    const path = await saveCaptured(join(dir, 'deep'), verdict('중첩'), 't');
    expect(await readFile(path, 'utf8')).toContain('# 중첩');
  });

  it('listCaptured가 카테고리별 저장 지식을 제목과 함께 반환한다 (정상)', async () => {
    await saveCaptured(dir, verdict('첫 지식'), 't');
    const entries = await listCaptured(dir);
    expect(entries).toHaveLength(1);
    expect(entries.at(0)).toMatchObject({ id: 'fact/첫-지식.md', title: '첫 지식', category: 'fact', status: 'draft' });
  });

  it('디렉토리가 없으면 빈 배열 (경계값)', async () => {
    expect(await listCaptured(join(dir, 'none'))).toEqual([]);
  });

  it('legacy Markdown은 verified로 목록화하고 unknown category는 제외한다', async () => {
    await mkdir(join(dir, 'concept'), { recursive: true });
    await mkdir(join(dir, 'unknown'), { recursive: true });
    await writeFile(join(dir, 'concept', 'legacy.md'), '# Legacy\n\nBody');
    await writeFile(join(dir, 'unknown', 'hidden.md'), '# Hidden\n\nBody');
    expect(await listCaptured(dir)).toContainEqual({
      id: 'concept/legacy.md', title: 'Legacy', category: 'concept', status: 'verified',
    });
    expect((await listCaptured(dir)).some((entry) => entry.id === 'unknown/hidden.md')).toBe(false);
  });

  it('draft를 verified로 승인하고 body를 보존한다', async () => {
    const path = await saveCaptured(dir, verdict('승인 지식'), '2026-07-21T00:00:00Z');
    const before = parseMarkdownDocument(await readFile(path, 'utf8'));
    const approved = await approveCaptured(dir, 'fact/승인-지식.md', '2026-07-21T01:00:00Z');
    const after = parseMarkdownDocument(await readFile(path, 'utf8'));
    expect(approved.status).toBe('verified');
    expect(after.body).toBe(before.body);
    expect(after.metadata).toMatchObject({ status: 'verified', reviewedAt: '2026-07-21T01:00:00Z' });
  });

  it('동시 승인은 한 요청만 상태 전이에 성공한다', async () => {
    await saveCaptured(dir, verdict('한번만 승인'), 't');
    const results = await Promise.allSettled([
      approveCaptured(dir, 'fact/한번만-승인.md', 'review-1'),
      approveCaptured(dir, 'fact/한번만-승인.md', 'review-2'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'NOT_DRAFT' } });
  });

  it.each([
    '../secret.md', '/tmp/secret.md', 'item.md', 'concept/nested/item.md', 'unknown/item.md', 'concept/item.txt',
  ])('invalid id %s를 거부한다', async (id) => {
    await expect(approveCaptured(dir, id, 't')).rejects.toMatchObject({ code: 'INVALID_ID' });
  });

  it('missing과 non-draft를 구분한다', async () => {
    await mkdir(join(dir, 'concept'), { recursive: true });
    await expect(approveCaptured(dir, 'concept/missing.md', 't')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await writeFile(join(dir, 'concept', 'legacy.md'), '# Legacy');
    await expect(approveCaptured(dir, 'concept/legacy.md', 't')).rejects.toMatchObject({ code: 'NOT_DRAFT' });
  });

  it('baseDir 밖을 가리키는 symlink id를 거부한다', async () => {
    const outside = join(dirname(dir), `${randomUUID()}-outside.md`);
    await writeFile(outside, '# outside');
    await mkdir(join(dir, 'concept'), { recursive: true });
    await symlink(resolve(outside), join(dir, 'concept', 'escape.md'));
    await expect(approveCaptured(dir, 'concept/escape.md', 't')).rejects.toMatchObject({ code: 'INVALID_ID' });
    await rm(outside, { force: true });
  });
});
