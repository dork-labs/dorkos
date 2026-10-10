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

  it('has nothing to say for a reason with no words', () => {
    expect(titleFromReason(undefined)).toBeNull();
    expect(titleFromReason('   ')).toBeNull();
    expect(titleFromReason('?')).toBeNull();
  });

  it('leaves a word that starts lowercase on purpose alone', () => {
    expect(titleFromReason('iOS build is red')).toBe('iOS build is red');
  });

  it('never splits an emoji when it cuts', () => {
    const title = titleFromReason(`ship ${'🚀'.repeat(80)}`)!;
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('startedChatTitle', () => {
  it('prefers the title the agent wrote', () => {
    expect(startedChatTitle('  Rooms:   answer people ', 'other words', 'Scout')).toBe(
      'Rooms: answer people'
    );
  });

  it('falls back to the reason', () => {
    expect(startedChatTitle(undefined, 'tidy the docs', 'Scout')).toBe('Tidy the docs');
  });

  it('names the agent when there is nothing else, never the brief', () => {
    expect(startedChatTitle(undefined, undefined, 'Scout')).toBe('Started by Scout');
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

  it('turns a rename that throws at once into a retry, not a crash', async () => {
    const rename = vi.fn((): Promise<void> => {
      throw new Error('no runtime');
    });
    const schedule = vi.fn();
    expect(() =>
      nameStartedChat({ rename, sessionId: 's', delaysMs: [5], schedule })
    ).not.toThrow();
    await flush();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('drops a retry that comes due after the first turn settled', async () => {
    const rename = vi.fn(async () => {
      throw new Error('Session not found');
    });
    const pending: (() => void)[] = [];
    const lastTry = nameStartedChat({
      rename,
      sessionId: 's',
      delaysMs: [5],
      schedule: (run) => pending.push(run),
    });
    await flush();
    lastTry();
    await flush();
    pending.shift()!();
    await flush();
    expect(rename).toHaveBeenCalledTimes(2);
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
