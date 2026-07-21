import { describe, expect, it } from 'vitest';
import {
  MAX_FRONTMATTER_CHARS,
  parseMarkdownDocument,
  serializeMarkdownDocument,
} from '../document.js';

describe('OKF document codec', () => {
  it('frontmatter가 없는 Markdown은 body를 그대로 보존한다', () => {
    expect(parseMarkdownDocument('# 제목\n본문')).toEqual({ metadata: null, body: '# 제목\n본문' });
  });

  it('known scalar와 flow-list를 파싱한다', () => {
    const parsed = parseMarkdownDocument(
      '---\ntype: "Reference"\ntitle: \'CLI\'\ntags: [cli, "http api"]\nstatus: draft\nreviewed_at: "2026-07-21T00:00:00Z"\n---\n\n# 본문',
    );
    expect(parsed.metadata).toEqual({
      type: 'Reference', title: 'CLI', tags: ['cli', 'http api'], status: 'draft', reviewedAt: '2026-07-21T00:00:00Z',
    });
    expect(parsed.body).toBe('# 본문');
  });

  it('serialize 결과를 다시 parse하면 metadata와 body가 보존된다', () => {
    const markdown = serializeMarkdownDocument({
      type: 'Captured Knowledge', title: '제목', description: '설명', resource: 'conversation://local',
      tags: ['captured', 'fact'], timestamp: '2026-07-21T00:00:00Z', status: 'verified',
      category: 'fact', provenance: 'conversation', reviewedAt: '2026-07-21T01:00:00Z',
    }, '# 제목\n본문');
    expect(parseMarkdownDocument(markdown)).toEqual({
      metadata: {
        type: 'Captured Knowledge', title: '제목', description: '설명', resource: 'conversation://local',
        tags: ['captured', 'fact'], timestamp: '2026-07-21T00:00:00Z', status: 'verified',
        category: 'fact', provenance: 'conversation', reviewedAt: '2026-07-21T01:00:00Z',
      },
      body: '# 제목\n본문\n',
    });
  });

  it('closing delimiter가 없으면 오류다', () => {
    expect(() => parseMarkdownDocument('---\ntype: Reference')).toThrow('closing delimiter');
  });

  it('unknown status는 오류다', () => {
    expect(() => parseMarkdownDocument('---\ntype: Reference\nstatus: pending\n---\nbody'))
      .toThrow('지원하지 않는 knowledge status');
  });

  it('64KiB를 초과한 frontmatter는 거부한다', () => {
    const value = 'x'.repeat(MAX_FRONTMATTER_CHARS + 1);
    expect(() => parseMarkdownDocument(`---\ndescription: ${value}\n---\nbody`)).toThrow('초과했습니다');
  });
});
