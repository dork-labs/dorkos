import { describe, it, expect, vi } from 'vitest';
import {
  nameStartedChat,
  REASON_TITLE_MAX,
  startedChatTitle,
  titleFromReason,
} from '../started-chat-title.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ error: String(err) }),
}));

/** Let every settled promise run its callbacks. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('titleFromReason', () => {
  it('keeps the first sentence, capitalised, with no closing full stop', () => {
    expect(titleFromReason('fix the release script. It fails on macOS.')).toBe(
      'Fix the release script'
    );
  });

  it('does not cut inside a version number or an abbreviation', () => {
    expect(titleFromReason('Ship v0.101.0 to npm')).toBe('Ship v0.101.0 to npm');
  });

  it('cuts a long sentence at a word and marks the cut', () => {
    const title = titleFromReason(
      'Make every room reply to the person who asked, even when several agents are present and busy'
    )!;
    expect(title.length).toBeLessThanOrEqual(REASON_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it('has nothing to say for an empty reason', () => {
    expect(titleFromReason(undefined)).toBeNull();
    expect(titleFromReason('   ')).toBeNull();
  });
});

describe('startedChatTitle', () => {
  it('prefers the title the agent wrote', () => {
    expect(startedChatTitle('  Rooms:   answer people ', 'other words')).toBe(
      'Rooms: answer people'
    );
  });

  it('falls back to the reason', () => {
    expect(startedChatTitle(undefined, 'tidy the docs')).toBe('Tidy the docs');
  });
});

describe('nameStartedChat', () => {
  it('stops at the first success', async () => {
    const rename = vi.fn(async () => {});
    const schedule = vi.fn();
    nameStartedChat({ rename, sessionId: 's', schedule });
    await flush();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('retries on the schedule until the runtime can take it', async () => {
    let calls = 0;
    const rename = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('Session not found');
    });
    const pending: (() => void)[] = [];
    nameStartedChat({
      rename,
      sessionId: 's',
      delaysMs: [1, 2, 3],
      schedule: (run) => pending.push(run),
    });
    await flush();
    pending.shift()!();
    await flush();
    pending.shift()!();
    await flush();
    expect(rename).toHaveBeenCalledTimes(3);
    expect(pending).toEqual([]);
  });

  it('tries once more when the first turn settles, and only once', async () => {
    const rename = vi.fn(async () => {
      throw new Error('Session not found');
    });
    const lastTry = nameStartedChat({
      rename,
      sessionId: 's',
      delaysMs: [],
      schedule: vi.fn(),
    });
    await flush();
    lastTry();
    lastTry();
    await flush();
    expect(rename).toHaveBeenCalledTimes(2);
  });
});
