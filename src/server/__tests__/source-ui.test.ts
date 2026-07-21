import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('source UI contract', () => {
  it('source resource는 protocol validation과 DOM API로 렌더한다', async () => {
    const html = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
    expect(html).toContain('function safeHttpUrl(value)');
    expect(html).toContain("url.protocol === 'http:' || url.protocol === 'https:'");
    expect(html).toContain("anchor.rel = 'noopener noreferrer'");
    expect(html).toContain('for (const source of ctx.sources) appendSource(body, source)');
    const source = html.match(/function safeHttpUrl\(value\) \{[\s\S]*?\n\}/)?.[0];
    if (source === undefined) throw new Error('safeHttpUrl source not found');
    const safeHttpUrl = runInNewContext(`(${source})`, { URL }) as (value: unknown) => string | null;
    expect(safeHttpUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,x')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
  });
});
