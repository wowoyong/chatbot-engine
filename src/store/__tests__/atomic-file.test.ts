import { readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../atomic-file.js';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = join('.test-tmp', randomUUID());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('기록한 내용을 그대로 읽을 수 있다 (정상)', async () => {
    const path = join(dir, 'a.json');
    await writeFileAtomic(path, '{"x":1}');
    expect(await readFile(path, 'utf8')).toBe('{"x":1}');
  });

  it('중첩 디렉토리가 없어도 자동 생성한다 (경계값)', async () => {
    const path = join(dir, 'deep', 'nested', 'a.txt');
    await writeFileAtomic(path, 'v');
    expect(await readFile(path, 'utf8')).toBe('v');
  });

  it('완료 후 .tmp 중간 파일이 남지 않는다 (경계값)', async () => {
    const path = join(dir, 'a.json');
    await writeFileAtomic(path, 'data');
    expect(await readdir(dir)).toEqual(['a.json']);
  });
});
