import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../llm/types.js';
import { SessionStore } from '../session-store.js';

const HISTORY: ChatMessage[] = [
  { role: 'user', content: '안녕' },
  { role: 'assistant', content: '안녕하세요' },
];

describe('SessionStore', () => {
  let dir: string;
  let filePath: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(dir, { recursive: true });
    filePath = join(dir, 'session.json');
    store = new SessionStore(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save 후 load하면 동일한 히스토리를 반환한다 (정상)', async () => {
    await store.save(HISTORY);
    expect(await store.load()).toEqual(HISTORY);
  });

  it('저장 완료 후 .tmp 중간 파일이 남지 않는다 (정상)', async () => {
    await store.save(HISTORY);
    const files = await readdir(dir);
    expect(files).toEqual(['session.json']);
  });

  it('파일이 없으면 null을 반환한다 (경계값)', async () => {
    expect(await store.load()).toBeNull();
  });

  it('손상된 JSON이면 .bak으로 보존하고 null을 반환한다 (에러)', async () => {
    await writeFile(filePath, '{ 깨진 json', 'utf8');
    expect(await store.load()).toBeNull();
    const files = await readdir(dir);
    expect(files).toContain('session.json.bak');
    expect(files).not.toContain('session.json');
  });

  it('JSON이지만 스키마가 다르면 .bak으로 보존하고 null을 반환한다 (에러)', async () => {
    await writeFile(filePath, JSON.stringify({ version: 1, history: [{ role: 'alien' }] }), 'utf8');
    expect(await store.load()).toBeNull();
    expect(await readdir(dir)).toContain('session.json.bak');
  });

  it('clear는 파일을 삭제하고, 없는 파일에 호출해도 오류가 없다 (경계값)', async () => {
    await store.save(HISTORY);
    await store.clear();
    expect(await store.load()).toBeNull();
    await store.clear();
  });
});
