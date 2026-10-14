/**
 * The end-of-turn reload reads only what the turn added (DOR-2890).
 */
import { describe, it, expect, vi } from 'vitest';
import type { HistoryMessage, HistoryRead } from '@dorkos/shared/types';
import { joinHistory, readTurnHistory } from '../turn-history';

const msg = (id: string, content = id) =>
  ({ id, role: id.startsWith('u') ? 'user' : 'assistant', content }) as HistoryMessage;

const held = [msg('u1'), msg('a1'), msg('u2'), msg('a2', 'partial')];

describe('joinHistory', () => {
  it('replaces with a whole read', () => {
    const whole = [msg('u1'), msg('a1')];
    expect(joinHistory(held, { messages: whole })).toBe(whole);
  });

  it('keeps what precedes the anchor and replaces from it, the anchor included', () => {
    const read: HistoryRead = { messages: [msg('a2', 'finished'), msg('u3')], tail: true };
    const joined = joinHistory(held, read)!;
    expect(joined.map((m) => m.content)).toEqual(['u1', 'a1', 'u2', 'finished', 'u3']);
    // Untouched history keeps its objects, so nothing before the turn redraws.
    expect(joined[0]).toBe(held[0]);
  });

  it('refuses a tail whose anchor the store no longer holds', () => {
    expect(joinHistory(held, { messages: [msg('zz')], tail: true })).toBeNull();
    expect(joinHistory(held, { messages: [], tail: true })).toBeNull();
  });
});

describe('readTurnHistory', () => {
  it('asks only since the newest message the person sent', async () => {
    // The reply after it may have been merged and renamed (a wake-up, an
    // approval pause), so it is never the anchor.
    const getMessages = vi.fn(async () => ({
      messages: [msg('u2'), msg('a2-renamed', 'done')],
      tail: true,
    }));
    const history = await readTurnHistory({ getMessages }, 's1', '/p', () => held);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledWith('s1', '/p', { since: 'u2' });
    expect(history.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2-renamed']);
    expect(history[0]).toBe(held[0]);
  });

  it('reads the whole history when it holds nothing to anchor on', async () => {
    const getMessages = vi.fn(async () => ({ messages: [msg('u1')] }));
    await readTurnHistory({ getMessages }, 's1', undefined, () => []);
    expect(getMessages).toHaveBeenCalledWith('s1', undefined);
  });

  it('falls back to the whole history when the store lost the anchor meanwhile', async () => {
    let current = held;
    const getMessages = vi
      .fn()
      .mockImplementationOnce(async () => {
        current = [msg('x1')]; // a snapshot replaced the store while the read was out
        return { messages: [msg('a2')], tail: true };
      })
      .mockImplementationOnce(async () => ({ messages: [msg('u1'), msg('a1')] }));
    const history = await readTurnHistory({ getMessages }, 's1', undefined, () => current);
    expect(getMessages).toHaveBeenNthCalledWith(2, 's1', undefined);
    expect(history.map((m) => m.id)).toEqual(['u1', 'a1']);
  });
});
