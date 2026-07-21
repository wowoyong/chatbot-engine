import { describe, expect, it, vi } from 'vitest';
import type { App } from '../../app/bootstrap.js';
import { formatCaptureSummary, handleKnowledgeReviewCommand } from '../main.js';

function fakeApp(): App {
  return {
    session: {} as App['session'], store: {} as App['store'], docsDir: 'docs', indexFile: 'index',
    modelName: 'fake', startupNotices: [], rebuildIndex: vi.fn(), captureKnowledge: vi.fn(),
    listCaptured: vi.fn().mockResolvedValue([
      { id: 'fact/item.md', title: 'Item', category: 'fact', status: 'draft' },
      { id: 'fact/done.md', title: 'Done', category: 'fact', status: 'verified' },
    ]),
    approveCaptured: vi.fn().mockResolvedValue({
      entry: { id: 'fact/item.md', title: 'Item', category: 'fact', status: 'verified' },
      indexUpdated: true,
    }),
  };
}

describe('handleKnowledgeReviewCommand', () => {
  it('captured 목록에 번호와 상태를 출력한다', async () => {
    const output: string[] = [];
    await expect(handleKnowledgeReviewCommand('/captured', fakeApp(), (text) => output.push(text), () => 't'))
      .resolves.toBe(true);
    expect(output.join('')).toContain('1. [draft] Item');
    expect(output.join('')).toContain('- [verified] Done');
  });

  it('approve 번호를 draft id로 바꾸고 주입한 시간을 전달한다', async () => {
    const app = fakeApp();
    const output: string[] = [];
    await handleKnowledgeReviewCommand('/approve 1', app, (text) => output.push(text), () => '2026-07-21T00:00:00Z');
    expect(app.approveCaptured).toHaveBeenCalledWith('fact/item.md', '2026-07-21T00:00:00Z');
    expect(output.join('')).toContain('승인됨: Item');
  });

  it('유효하지 않은 번호와 승인 오류를 안내한다', async () => {
    const output: string[] = [];
    await handleKnowledgeReviewCommand('/approve 9', fakeApp(), (text) => output.push(text), () => 't');
    expect(output.join('')).toContain('유효한 항목 번호');
    const app = fakeApp();
    vi.mocked(app.approveCaptured).mockRejectedValueOnce(new Error('not draft'));
    await handleKnowledgeReviewCommand('/approve 1', app, (text) => output.push(text), () => 't');
    expect(output.join('')).toContain('승인 오류: not draft');
  });

  it('관련 없는 command는 처리하지 않는다', async () => {
    await expect(handleKnowledgeReviewCommand('/index', fakeApp(), () => undefined, () => 't')).resolves.toBe(false);
  });
});

describe('formatCaptureSummary', () => {
  it('durable save 후 재색인 실패 경고를 함께 출력한다', () => {
    expect(formatCaptureSummary({
      extracted: 1,
      saved: ['a.md'],
      skipped: [],
      indexUpdated: false,
      warning: 'draft는 저장됐지만 /index가 필요합니다.',
    })).toContain('draft는 저장됐지만 /index가 필요합니다.');
  });
});
