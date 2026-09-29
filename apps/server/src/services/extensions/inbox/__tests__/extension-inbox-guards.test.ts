/**
 * The guards the server-half review asked for (DOR-2523): a person's answer
 * always beats the deadline, a re-raise never moves or re-arms a deadline, an
 * answer and a deadline never both reach the handler, one extension cannot
 * flood Activity, a banner never shows an extension's own words, and the
 * smaller rules around re-raising, crediting and offers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extensionDecisions, notifications } from '@dorkos/db';
import type { DecisionActionEvent } from '@dorkos/extension-api/server';
import { createInboxFixture, flush, shipDecision, type InboxFixture } from './inbox-fixture.js';

const ONE_MINUTE = 60_000;
const RAISED_AT = new Date('2026-09-29T09:00:00.000Z');
let fx: InboxFixture;

/** A question whose deadline is `inMinutes` after raise time, as the extension asked it. */
function question(decideBy: string, overrides: Record<string, unknown> = {}) {
  return {
    key: 'old-api',
    title: 'Should the old API keep working?',
    why: 'Removing it breaks two scripts.',
    project: '/repos/dorkos',
    actions: {
      kind: 'choice' as const,
      choices: [
        { id: 'keep', label: 'Keep it' },
        { id: 'remove', label: 'Remove it' },
      ],
      defaultChoice: 'keep',
      decideBy,
    },
    ...overrides,
  };
}

const at = (minutes: number) => new Date(RAISED_AT.getTime() + minutes * ONE_MINUTE).toISOString();
const row = () => fx.db.select().from(extensionDecisions).all()[0];

beforeEach(() => {
  vi.useFakeTimers({ now: RAISED_AT });
  fx = createInboxFixture();
  fx.inbox.markRunning('flow', 'Flow');
});

afterEach(() => {
  fx.inbox.stop();
  fx.close();
  vi.useRealTimers();
});

describe('a person’s answer beats the deadline (blocker 1)', () => {
  it('cancels the deadline for good when the extension keeps the row open', async () => {
    const calls: DecisionActionEvent[] = [];
    fx.inbox.setHandler('flow', (event) => {
      calls.push(event);
      return event.decidedBy === 'person' ? { keepOpen: true } : { resolve: 'answered' };
    });
    await fx.inbox.raise('flow', 'Flow', question(at(10)));
    const [open] = fx.inbox.listOpen();
    await fx.inbox.answer(open.id, { action: 'choice', choiceId: 'remove' }, { kind: 'person' });

    await vi.advanceTimersByTimeAsync(30 * ONE_MINUTE);
    await flush();

    expect(calls.map((call) => call.decidedBy)).toEqual(['person']);
    expect(row().resolvedAt).toBeNull();
    expect(fx.inbox.listOpen()[0].actions).not.toHaveProperty('decideBy');
  });
});

describe('a re-raise never moves or re-arms a deadline (blocker 2)', () => {
  it('keeps the deadline the extension first asked for when it re-raises the same question', async () => {
    const handler = vi.fn().mockResolvedValue({ resolve: 'answered' });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(at(10)));
    await vi.advanceTimersByTimeAsync(8 * ONE_MINUTE);
    await fx.inbox.raise('flow', 'Flow', question(at(10), { title: 'Keep the old API working?' }));
    expect(fx.inbox.listOpen()[0].actions).toMatchObject({ decideBy: at(10) });
    await vi.advanceTimersByTimeAsync(2 * ONE_MINUTE);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps a row the extension kept open at its deadline kept open on a re-raise', async () => {
    const handler = vi.fn().mockResolvedValue({ keepOpen: true });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(at(10)));
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();
    expect(row().deadlineState).toBe('kept_open');

    await fx.inbox.raise('flow', 'Flow', question(at(10)));
    await vi.advanceTimersByTimeAsync(30 * ONE_MINUTE);
    await flush();
    expect(row().deadlineState).toBe('kept_open');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('starts over, and forgets a pending answer and a watch, when the question itself changes', async () => {
    fx.inbox.setHandler('flow', () => ({
      keepOpen: true,
      watch: { sessionId: 'chat-1', label: 'Checking…' },
    }));
    await fx.inbox.raise('flow', 'Flow', question(at(10)));
    const [open] = fx.inbox.listOpen();
    await fx.inbox.answer(open.id, { action: 'choice', choiceId: 'keep' }, { kind: 'person' });
    expect(row().pendingActionJson).not.toBeNull();

    await fx.inbox.raise(
      'flow',
      'Flow',
      question(at(60), {
        actions: {
          kind: 'choice',
          choices: [
            { id: 'v1', label: 'Keep v1' },
            { id: 'v2', label: 'Move to v2' },
          ],
          defaultChoice: 'v1',
          decideBy: at(60),
        },
      })
    );
    expect(row()).toMatchObject({ pendingActionJson: null, watchJson: null, deadlineState: null });
  });
});

describe('an answer and a deadline never both reach the handler (3)', () => {
  it('pauses the deadline while a person’s answer is with the extension', async () => {
    const calls: string[] = [];
    fx.inbox.setHandler('flow', async (event) => {
      calls.push(event.decidedBy);
      if (event.decidedBy === 'person') {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      return { resolve: 'answered' };
    });
    await fx.inbox.raise('flow', 'Flow', question(at(5)));
    await vi.advanceTimersByTimeAsync(5 * ONE_MINUTE - 1_000);
    const [open] = fx.inbox.listOpen();
    const answering = fx.inbox.answer(
      open.id,
      { action: 'choice', choiceId: 'remove' },
      { kind: 'person' }
    );
    await vi.advanceTimersByTimeAsync(4_000);
    await answering;
    await flush();
    expect(calls).toEqual(['person']);
  });

  it('puts the deadline back when the answer fails', async () => {
    const calls: string[] = [];
    fx.inbox.setHandler('flow', (event) => {
      calls.push(event.decidedBy);
      if (event.decidedBy === 'person') throw new Error('tracker down');
      return { resolve: 'answered' };
    });
    await fx.inbox.raise('flow', 'Flow', question(at(10)));
    const [open] = fx.inbox.listOpen();
    await fx.inbox.answer(open.id, { action: 'choice', choiceId: 'remove' }, { kind: 'person' });
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();
    expect(calls).toEqual(['person', 'deadline']);
  });
});

describe('one extension cannot flood Activity (4)', () => {
  const record = (key: string) =>
    fx.inbox.record('flow', 'Flow', {
      key,
      title: 'Sorted ideas',
      why: 'They were waiting.',
      outcome: 'answered',
      by: { kind: 'rule', label: "your 'Just do it' setting" },
    });

  it('refuses more than 60 new decisions an hour, and allows them again as the hour moves on', async () => {
    for (let i = 0; i < 60; i += 1) await record(`k${i}`);
    await expect(record('k60')).rejects.toMatchObject({ code: 'inbox_limit', limit: 'rate' });
    await expect(
      fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'fresh' }))
    ).rejects.toMatchObject({ limit: 'rate' });
    // Another extension has its own budget.
    await expect(
      fx.inbox.record('other', 'Other', {
        key: 'x',
        title: 'T',
        why: 'W',
        outcome: 'answered',
        by: { kind: 'deadline' },
      })
    ).resolves.toBeUndefined();
    vi.setSystemTime(new Date(RAISED_AT.getTime() + 61 * ONE_MINUTE));
    await expect(record('k61')).resolves.toBeUndefined();
  });

  it('keeps at most 100 of one extension’s history rows, and never touches other kinds', async () => {
    await fx.store.insert({
      kind: 'turn.completed',
      tier: 'notable',
      subjectType: 'session',
      subjectId: 's-1',
      title: 'Kai finished',
      payload: {},
      dedupeKey: 'turn:s-1',
      read: false,
    });
    for (let i = 0; i < 120; i += 1) {
      vi.setSystemTime(new Date(RAISED_AT.getTime() + i * ONE_MINUTE));
      await record(`k${i}`);
    }
    expect(fx.history()).toHaveLength(100);
    expect(fx.history().some((h) => h.title === 'Sorted ideas')).toBe(true);
    expect(
      fx.db
        .select()
        .from(notifications)
        .all()
        .map((n) => n.kind)
    ).toContain('turn.completed');
  });
});

describe('a banner never shows an extension’s own words (5)', () => {
  it('announces a decision as "<name> needs you", never its title or reason', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const [event] = fx.pendingEvents() as Array<{ title: string; body?: string }>;
    expect(event.title).toBe('Flow needs you in 1 project');
    expect(event.body ?? '').not.toContain('reviewer agent');
    expect(event.title).not.toContain('banner');
  });

  it('pushes once per extension per episode, however many rows are open', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'a' }));
    await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'b', project: '/repos/blintz' }));
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).toHaveBeenCalledTimes(1);
    expect((fx.sendToAll.mock.calls[0][0] as { title: string }).title).toBe(
      'Flow needs you in 2 projects'
    );
  });
});

describe('crediting, offers and late timers (nits)', () => {
  it('refuses `answering` with an outcome that contradicts what the person chose', async () => {
    let pendingActionId: string | null = null;
    fx.inbox.setHandler('flow', (event) => {
      pendingActionId = event.pendingActionId;
      return { keepOpen: true };
    });
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const [open] = fx.inbox.listOpen();
    await fx.inbox.answer(open.id, { action: 'reject' }, { kind: 'person' });
    await expect(
      fx.inbox.resolve('flow', 'ship:DOR-2387', {
        outcome: 'approved',
        answering: pendingActionId!,
      })
    ).rejects.toThrow(/contradicts/);
    expect(fx.inbox.listOpen()).toHaveLength(1);
    await expect(
      fx.inbox.resolve('flow', 'ship:DOR-2387', {
        outcome: 'rejected',
        answering: pendingActionId!,
      })
    ).resolves.toBe(true);
  });

  it('drops an offer whose settings patch is larger than 16 KiB', async () => {
    fx.inbox.setHandler('flow', () => ({
      resolve: 'approved',
      offer: {
        text: 'Next time?',
        offerId: 'o',
        settingsPatch: { project: '/repos/dorkos', patch: { blob: 'x'.repeat(17 * 1024) } },
      },
    }));
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const [open] = fx.inbox.listOpen();
    const answer = await fx.inbox.answer(open.id, { action: 'approve' }, { kind: 'person' });
    expect(answer).toMatchObject({ ok: true, response: { offer: null } });
    expect(fx.inbox.pendingOffers()).toEqual([]);
  });

  it('fires an overdue deadline on the next sweep when its timer came late (a sleeping laptop)', async () => {
    const handler = vi.fn().mockResolvedValue({ resolve: 'answered' });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', question(at(10)));
    // The wall clock moves an hour; the timer does not.
    vi.setSystemTime(new Date(RAISED_AT.getTime() + 60 * ONE_MINUTE));
    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].decidedBy).toBe('deadline');
  });
});

describe('answers name the question they saw (client review 2)', () => {
  it('bumps the revision only when what is asked changes, and refuses a stale answer', async () => {
    const handler = vi.fn().mockResolvedValue({ resolve: 'approved' });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const first = fx.inbox.listOpen()[0].revision;
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    expect(fx.inbox.listOpen()[0].revision).toBe(first);
    await fx.inbox.raise('flow', 'Flow', shipDecision({ title: 'Ship the calmer banner?' }));
    const [open] = fx.inbox.listOpen();
    expect(open.revision).toBe(first + 1);

    expect(
      await fx.inbox.answer(open.id, { action: 'approve', revision: first }, { kind: 'person' })
    ).toMatchObject({ ok: false, status: 409, code: 'stale_decision' });
    expect(handler).not.toHaveBeenCalled();
    expect(
      await fx.inbox.answer(
        open.id,
        { action: 'approve', revision: open.revision },
        { kind: 'person' }
      )
    ).toMatchObject({ ok: true });
  });
});

describe('a later credit’s offer is listed (client review 1)', () => {
  it('lists an offer made through resolve(..., { answering })', async () => {
    let pendingActionId: string | null = null;
    fx.inbox.setHandler('flow', (event) => {
      pendingActionId = event.pendingActionId;
      return { keepOpen: true };
    });
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const [open] = fx.inbox.listOpen();
    await fx.inbox.answer(open.id, { action: 'approve' }, { kind: 'person' });
    await fx.inbox.resolve('flow', 'ship:DOR-2387', {
      outcome: 'approved',
      answering: pendingActionId!,
      offer: { text: 'Next time?', offerId: 'o' },
    });
    expect(fx.inbox.pendingOffers()).toEqual([
      expect.objectContaining({ decisionId: open.id, text: 'Next time?' }),
    ]);
  });
});

describe('server re-review', () => {
  it('pushes a question raised after the hour’s push once the hour is over (blocker)', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'a' }));
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).toHaveBeenCalledTimes(1);
    await fx.inbox.resolve('flow', 'a', { outcome: 'cleared' });

    await vi.advanceTimersByTimeAsync(7 * ONE_MINUTE);
    await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'b' }));
    await vi.advanceTimersByTimeAsync(5 * 60 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).toHaveBeenCalledTimes(2);
    expect(fx.inbox.listOpen().map((d) => d.key)).toEqual(['b']);
  });

  it('trims read history before unread, and never the row a waiting offer sits under', async () => {
    const record = (key: string, tell: boolean) =>
      fx.inbox.record('flow', 'Flow', {
        key,
        title: key,
        why: 'Decided while you were away.',
        outcome: 'answered',
        by: { kind: 'rule', label: "your 'Tell me after' setting" },
        tell,
      });
    // An answered row with a waiting offer, oldest of all.
    let pendingActionId: string | null = null;
    fx.inbox.setHandler('flow', (event) => {
      pendingActionId = event.pendingActionId;
      return { keepOpen: true };
    });
    await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'offered' }));
    const [open] = fx.inbox.listOpen();
    await fx.inbox.answer(open.id, { action: 'approve' }, { kind: 'person' });
    await fx.inbox.resolve('flow', 'offered', {
      outcome: 'approved',
      answering: pendingActionId!,
      offer: { text: 'Next time?', offerId: 'o' },
    });
    // Then unread rows, then more read rows than the cap allows.
    for (let i = 0; i < 10; i += 1) {
      vi.setSystemTime(new Date(RAISED_AT.getTime() + (i + 1) * ONE_MINUTE));
      await record(`unread-${i}`, true);
    }
    for (let i = 0; i < 95; i += 1) {
      vi.setSystemTime(new Date(RAISED_AT.getTime() + (i + 20) * ONE_MINUTE));
      await record(`read-${i}`, false);
    }
    const titles = fx.history().map((h) => h.title);
    expect(titles).toHaveLength(100);
    expect(titles).toContain('Ship the new out-of-usage banner?');
    expect(titles.filter((t) => t.startsWith('unread-'))).toHaveLength(10);
  });

  it('refuses an answer when the question changed while the extension had it', async () => {
    fx.inbox.setHandler('flow', async () => {
      await fx.inbox.raise('flow', 'Flow', shipDecision({ title: 'Ship the calmer banner?' }));
      return { resolve: 'approved' };
    });
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const [open] = fx.inbox.listOpen();
    expect(
      await fx.inbox.answer(
        open.id,
        { action: 'approve', revision: open.revision },
        { kind: 'person' }
      )
    ).toMatchObject({ ok: false, code: 'stale_decision' });
    expect(fx.inbox.listOpen()[0].title).toBe('Ship the calmer banner?');
  });

  it('treats a re-raise whose only change is a moving relative deadline as the same question', async () => {
    let pendingActionId: string | null = null;
    fx.inbox.setHandler('flow', (event) => {
      pendingActionId = event.pendingActionId;
      return { keepOpen: true };
    });
    await fx.inbox.raise('flow', 'Flow', question(at(60)));
    const [open] = fx.inbox.listOpen();
    await fx.inbox.answer(open.id, { action: 'choice', choiceId: 'keep' }, { kind: 'person' });
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    // The extension asks again with "an hour from now", which has moved.
    await fx.inbox.raise('flow', 'Flow', question(at(70)));
    const after = fx.inbox.listOpen()[0];
    expect(after.revision).toBe(open.revision);
    expect(row().pendingActionJson).not.toBeNull();
    await expect(
      fx.inbox.resolve('flow', 'old-api', { outcome: 'answered', answering: pendingActionId! })
    ).resolves.toBe(true);
    expect(fx.history()[0].body).toBe('Keep it · you');
  });
});
