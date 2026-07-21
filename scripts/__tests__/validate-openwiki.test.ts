import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_OPENWIKI_PATHS, validateOpenWiki } from '../validate-openwiki.js';

const roots: string[] = [];

async function createFixture(): Promise<{ repo: string; openwiki: string }> {
  const repo = join('.test-tmp', randomUUID());
  roots.push(repo);
  const openwiki = join(repo, 'openwiki');
  await mkdir(openwiki, { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', dev: 'tsx src/main.ts' } }));
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'main.ts'), '');
  for (const path of REQUIRED_OPENWIKI_PATHS) {
    const target = join(openwiki, path);
    await mkdir(dirname(target), { recursive: true });
    if (path === 'index.md') await writeFile(target, '---\nokf_version: 0.1\n---\n');
    else if (path === 'log.md') await writeFile(target, '# Log');
    else await writeFile(target, [
      '---', 'type: Reference', `title: "${path}"`, 'description: "fixture"',
      'tags: []', 'timestamp: "2026-07-21T00:00:00Z"', '---', '', `# ${path}`, '',
    ].join('\n'));
  }
  return { repo, openwiki };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('validateOpenWiki', () => {
  it('유효한 최소 bundle은 issue가 없다', async () => {
    const fixture = await createFixture();
    await expect(validateOpenWiki(fixture.openwiki, fixture.repo)).resolves.toEqual([]);
  });

  it('metadata, link, command drift를 한 번에 보고한다', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.openwiki, 'components', 'rag.md'), [
      '# RAG', '[missing](./missing.md)', '`npm run removed-script`', '`npm start`',
    ].join('\n'));
    const messages = (await validateOpenWiki(fixture.openwiki, fixture.repo)).map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('type'), expect.stringContaining('missing.md'),
      expect.stringContaining('removed-script'), expect.stringContaining('npm start'),
    ]));
  });

  it('root 밖 link와 unpinned OpenWiki command를 거부한다', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.openwiki, 'quickstart.md'), [
      '---', 'type: Reference', 'tags: []', '---', '', '[outside](../../secret.md)', '`npx -y openwiki code --update`',
    ].join('\n'));
    const messages = (await validateOpenWiki(fixture.openwiki, fixture.repo)).map((issue) => issue.message);
    expect(messages.some((message) => message.includes('escapes'))).toBe(true);
    expect(messages.some((message) => message.includes('pin 0.2.1'))).toBe(true);
  });

  it('필수 OKF metadata type 누락을 보고한다', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.openwiki, 'components', 'rag.md'), '---\ntitle: RAG\n---\n\n# RAG');
    const messages = (await validateOpenWiki(fixture.openwiki, fixture.repo)).map((issue) => issue.message);
    expect(messages.some((message) => message.includes('metadata type'))).toBe(true);
  });

  it('fenced stale command와 잘못된 link encoding을 issue로 누적한다', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.openwiki, 'components', 'rag.md'), [
      '---', 'type: Reference', 'title: RAG', 'description: fixture', 'tags: []',
      'timestamp: 2026-07-21T00:00:00Z', '---', '', '[bad](%ZZ.md)',
      '```bash', 'npm run removed-script', '```',
    ].join('\n'));
    const messages = (await validateOpenWiki(fixture.openwiki, fixture.repo)).map((issue) => issue.message);
    expect(messages.some((message) => message.includes('invalid link encoding'))).toBe(true);
    expect(messages.some((message) => message.includes('removed-script'))).toBe(true);
  });
});
