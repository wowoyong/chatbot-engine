import { describe, expect, it } from 'vitest';
import { MutationQueue } from '../mutation-queue.js';

describe('MutationQueue', () => {
  it('동시 요청을 FIFO로 실행한다', async () => {
    const queue = new MutationQueue();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run(async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
    });
    const second = queue.run(async () => { events.push('second'); });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    if (release === undefined) throw new Error('release was not initialized');
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('실패 후 다음 작업을 실행한다', async () => {
    const queue = new MutationQueue();
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(queue.run(async () => 42)).resolves.toBe(42);
  });
});
