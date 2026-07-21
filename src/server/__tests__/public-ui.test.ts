import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('captured review UI', () => {
  it('captured 항목은 textContent로 표시하고 approve endpoint에 id만 보낸다', async () => {
    const html = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
    expect(html).toContain('async function loadCaptured()');
    expect(html).toContain("label.textContent = '[' + entry.status + '] ' + entry.title");
    expect(html).toContain("fetch('/api/captured/approve'");
    expect(html).toContain('body: JSON.stringify({ id: entry.id })');
    expect(html).toContain('capturedList.replaceChildren()');
    expect(html).toContain("if (data.warning) notice.textContent += ' ' + data.warning");
  });
});
