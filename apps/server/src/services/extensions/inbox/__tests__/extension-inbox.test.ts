/**
 * `ctx.inbox`, core's side (spec `flow-multiproject` §7.1-§7.4, §7.9;
 * invariants 2, 4, 11, 12). Raising, dedupe, limits, links, who decided, the
 * two answer paths, and the lifecycle that hides what nobody can answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InboxLimitError, InboxLinkError } from '@dorkos/extension-api/server';
import { extensionDecisions } from '@dorkos/db';
import { createInboxFixture, flush, shipDecision, type InboxFixture } from './inbox-fixture.js';

const ONE_MINUTE = 60_000;
let fx: InboxFixture;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-29T09:00:00.000Z') });
  fx = createInboxFixture();
  fx.inbox.markRunning('flow', 'Flow');
  fx.inbox.markRunning('other', 'Other');
});

afterEach(() => {
  fx.inbox.stop();
  fx.close();
  vi.useRealTimers();
});

describe('raise', () => {
  it('stores one open row, announces it, and resolves its project', async () => {
    const raised = await fx.inbox.raise('flow', 'Flow', shipDecision());
    expect(raised.project).toEqual({ root: '/repos/dorkos', name: 'dorkos' });
    expect(fx.inbox.listOpen()).toHaveLength(1);
    expect(fx.inbox.listOpen()[0]).toMatchObject({
      extensionName: 'Flow',
      projectLabel: 'Linear DOR',
      why: expect.stringContaining('tests pass'),
      needsYou: false,
    });
    expect(fx.pendingEvents()).toHaveLength(1);
  });

  it('updates an open key in place and never pushes twice (one live row per key)', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    await fx.inbox.raise('flow', 'Flow', shipDecision({ title: 'Ship the banner now?' }));
    expect(fx.db.select().from(extensionDecisions).all()).toHaveLength(1);
    expect(fx.inbox.listOpen()[0].title).toBe('Ship the banner now?');

    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).toHaveBeenCalledTimes(1);
  });

  it('pushes a generic line with the link, never the title or project', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    const sent = fx.sendToAll.mock.calls[0][0] as {
      title: string;
      body?: string;
      deepLink: string;
    };
    expect(sent.title).toBe('Flow needs you in 1 project');
    // What a lock screen shows: the title and body, never the decision's words.
    const shown = `${sent.title} ${sent.body ?? ''}`;
    expect(shown).not.toContain('banner');
    expect(shown).not.toContain('dorkos');
    expect(shown).not.toContain('ship:DOR-2387');
    expect(sent.deepLink).toBe('/x/flow/p/dorkos');
  });

  it('falls back to home as the push deep link when there is no link', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision({ link: undefined }));
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect((fx.sendToAll.mock.calls[0][0] as { deepLink: string }).deepLink).toBe('/');
  });

  it.each([
    ['a missing why', { why: undefined }, 'why'],
    ['a blank why', { why: '   ' }, 'why'],
    ['a 301-character why', { why: 'x'.repeat(301) }, 'why'],
    ['a 121-character title', { title: 't'.repeat(121) }, 'title'],
    ['a 501-character detail', { detail: 'd'.repeat(501) }, 'detail'],
    ['a bad key', { key: '-no' }, 'key'],
    [
      'a question with one choice',
      { actions: { kind: 'choice', choices: [{ id: 'a', label: 'A' }] } },
      'choices',
    ],
    [
      'a deadline without the agent’s pick',
      {
        actions: {
          kind: 'choice',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          decideBy: '2026-09-29T17:00:00.000Z',
        },
      },
      'decideBy',
    ],
    [
      'a deadline more than 7 days ahead',
      {
        actions: {
          kind: 'choice',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          defaultChoice: 'a',
          decideBy: '2026-10-07T09:00:00.000Z',
        },
      },
      'decideBy',
    ],
  ])('refuses %s and writes nothing', async (_name, change, limit) => {
    const error = await fx.inbox.raise('flow', 'Flow', shipDecision(change)).catch((e) => e);
    expect(error).toBeInstanceOf(InboxLimitError);
    expect((error as InboxLimitError).code).toBe('inbox_limit');
    expect((error as InboxLimitError).limit).toBe(limit);
    expect(fx.db.select().from(extensionDecisions).all()).toHaveLength(0);
  });

  it('refuses the 51st open decision of one extension', async () => {
    for (let i = 0; i < 50; i += 1) {
      await fx.inbox.raise('flow', 'Flow', shipDecision({ key: `k${i}` }));
    }
    const error = await fx.inbox
      .raise('flow', 'Flow', shipDecision({ key: 'k50' }))
      .catch((e) => e);
    expect((error as InboxLimitError).limit).toBe('open');
    // Another extension has its own 50.
    await expect(
      fx.inbox.raise('other', 'Other', shipDecision({ key: 'k50', link: undefined }))
    ).resolves.toBeTruthy();
  });

  it.each([
    'https://evil.example/x',
    'javascript:alert(1)',
    '//evil.example/x',
    '/x/other/page',
    'data:text/html,hi',
    '/x/flow/../other/page',
  ])('refuses %s as a link, and as a word action’s href', async (link) => {
    await expect(fx.inbox.raise('flow', 'Flow', shipDecision({ link }))).rejects.toBeInstanceOf(
      InboxLinkError
    );
    await expect(
      fx.inbox.raise(
        'flow',
        'Flow',
        shipDecision({ link: undefined, actions: { kind: 'word', label: 'Open', href: link } })
      )
    ).rejects.toMatchObject({ code: 'inbox_link' });
    expect(fx.db.select().from(extensionDecisions).all()).toHaveLength(0);
  });

  it('accepts a core route and its own pages as links', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'a', link: '/tasks' }));
    await fx.inbox.raise(
      'flow',
      'Flow',
      shipDecision({ key: 'b', link: '/x/flow?project=dorkos' })
    );
    expect(fx.inbox.listOpen()).toHaveLength(2);
  });
});

describe('namespacing (invariant 4)', () => {
  it('keeps one extension out of another’s decisions', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    expect(await fx.inbox.resolve('other', 'ship:DOR-2387', { outcome: 'cleared' })).toBe(false);
    expect(fx.inbox.list('other')).toEqual([]);
    const id = fx.inbox.listOpen()[0].id;
    fx.inbox.setHandler('other', () => ({ resolve: 'approved' }));
    const answer = await fx.inbox.answer(
      id,
      { action: 'approve' },
      { kind: 'extension', extensionId: 'other' }
    );
    expect(answer).toMatchObject({ ok: false, status: 404 });
    expect(fx.inbox.listOpen()).toHaveLength(1);
  });

  it('lets two extensions use the same key', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    await fx.inbox.raise('other', 'Other', shipDecision({ link: undefined }));
    expect(fx.inbox.listOpen()).toHaveLength(2);
  });
});

describe('resolve and who decided (§7.9)', () => {
  it('writes one "Resolved on its own" history row for cleared, then answers false', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    expect(await fx.inbox.resolve('flow', 'ship:DOR-2387', { outcome: 'cleared' })).toBe(true);
    expect(await fx.inbox.resolve('flow', 'ship:DOR-2387', { outcome: 'cleared' })).toBe(false);
    const history = fx.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ outcome: 'cleared', body: 'Resolved on its own' });
    expect(fx.inbox.listOpen()).toEqual([]);
  });

  it('shows an agent’s label, and a deadline as "decided by the agent"', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'a' }));
    await fx.inbox.resolve('flow', 'a', {
      outcome: 'approved',
      by: { kind: 'agent', label: 'the reviewer agent' },
    });
    await fx.inbox.raise('flow', 'Flow', shipDecision({ key: 'b' }));
    await fx.inbox.resolve('flow', 'b', { outcome: 'approved', by: { kind: 'deadline' } });
    const [agent, deadline] = fx.history();
    expect(agent.body).toBe('Ship it · the reviewer agent');
    expect(deadline.body).toBe('Ship it · decided by the agent');
    const dto = fx.store.list({ limit: 25, unread: false }).notifications;
    expect(dto.map((n) => n.decision?.resolvedBy).sort()).toEqual(['agent', 'deadline']);
  });

  it('stops the escalation clock when resolved', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    await fx.inbox.resolve('flow', 'ship:DOR-2387', { outcome: 'cancelled' });
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).not.toHaveBeenCalled();
  });
});

describe('answering in core’s UI (a person)', () => {
  it('refuses when the extension is not running, or not listening', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const id = fx.inbox.listOpen()[0].id;
    expect(await fx.inbox.answer(id, { action: 'approve' }, { kind: 'person' })).toMatchObject({
      ok: false,
      status: 409,
      code: 'not_running',
      message: "Flow isn't running right now.",
    });
  });

  it('resolves as the person, with the handler’s message, navigate and offer', async () => {
    const handler = vi.fn().mockResolvedValue({
      resolve: 'approved',
      message: 'Shipping it.',
      navigate: '/x/flow/p/dorkos',
      offer: { text: 'Shipped. Next time, ship on its own?', offerId: 'auto-ship' },
    });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const id = fx.inbox.listOpen()[0].id;
    const answer = await fx.inbox.answer(id, { action: 'approve' }, { kind: 'person' });
    expect(answer).toEqual({
      ok: true,
      response: {
        resolved: true,
        message: 'Shipping it.',
        navigate: '/x/flow/p/dorkos',
        offer: { text: 'Shipped. Next time, ship on its own?' },
        watch: null,
      },
    });
    expect(handler.mock.calls[0][0]).toMatchObject({
      key: 'ship:DOR-2387',
      action: 'approve',
      decidedBy: 'person',
      pendingActionId: expect.any(String),
      project: { root: '/repos/dorkos', name: 'dorkos' },
    });
    expect(fx.history()[0].body).toBe('Ship it · you');
    // The offer went back with the answer, to the one client that gave it;
    // it is never listed for other devices.
    expect(fx.inbox.pendingOffers()).toEqual([]);
    expect(await fx.inbox.answerOffer(id, false)).toMatchObject({ ok: true });
  });

  it('asks for the note on "Needs changes" and hands it over', async () => {
    const handler = vi.fn().mockResolvedValue({ resolve: 'rejected' });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise(
      'flow',
      'Flow',
      shipDecision({
        actions: {
          kind: 'yes-no',
          approveLabel: 'Looks good',
          rejectLabel: 'Needs changes',
          rejectAsksForNote: true,
        },
      })
    );
    const id = fx.inbox.listOpen()[0].id;
    await fx.inbox.answer(
      id,
      { action: 'reject', note: 'Use the calmer red.' },
      { kind: 'person' }
    );
    expect(handler.mock.calls[0][0].note).toBe('Use the calmer red.');
    expect(fx.db.select().from(extensionDecisions).all()[0].note).toBe('Use the calmer red.');
  });

  it('keeps the row open on keepOpen, and credits the person when the extension resolves with answering', async () => {
    let pendingActionId: string | null = null;
    fx.inbox.setHandler('flow', (event) => {
      pendingActionId = event.pendingActionId;
      return { keepOpen: true, message: 'Checking with the reviewer agent.' };
    });
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const id = fx.inbox.listOpen()[0].id;
    const answer = await fx.inbox.answer(id, { action: 'approve' }, { kind: 'person' });
    expect(answer).toMatchObject({
      ok: true,
      response: { resolved: false, message: 'Checking with the reviewer agent.' },
    });
    expect(fx.inbox.listOpen()).toHaveLength(1);

    await fx.inbox.resolve('flow', 'ship:DOR-2387', {
      outcome: 'approved',
      answering: pendingActionId!,
      offer: { text: 'Next time, ship on its own?', offerId: 'o1' },
    });
    expect(fx.history()[0].body).toBe('Ship it · you');
    expect(fx.inbox.pendingOffers()).toHaveLength(1);
  });

  it('ignores a foreign pendingActionId: the resolve is the extension’s, with no offer', async () => {
    fx.inbox.setHandler('flow', () => ({ keepOpen: true }));
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const id = fx.inbox.listOpen()[0].id;
    await fx.inbox.answer(id, { action: 'approve' }, { kind: 'person' });
    await fx.inbox.resolve('flow', 'ship:DOR-2387', {
      outcome: 'approved',
      answering: '01J00000000000000000000000',
      offer: { text: 'Next time?', offerId: 'o1' },
    });
    expect(fx.history()[0].body).toBe('Ship it · Flow');
    expect(fx.inbox.pendingOffers()).toEqual([]);
  });

  it('answers already_resolved when the extension settled it while the handler ran', async () => {
    fx.inbox.setHandler('flow', async () => {
      await fx.inbox.resolve('flow', 'ship:DOR-2387', { outcome: 'cleared' });
      return { resolve: 'approved' };
    });
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const id = fx.inbox.listOpen()[0].id;
    expect(await fx.inbox.answer(id, { action: 'approve' }, { kind: 'person' })).toMatchObject({
      ok: false,
      status: 409,
      code: 'already_resolved',
    });
    expect(fx.history()).toHaveLength(1);
    expect(fx.history()[0].outcome).toBe('cleared');
  });

  it('keeps the row on a handler that takes longer than 5 seconds', async () => {
    fx.inbox.setHandler('flow', () => new Promise(() => {}));
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const id = fx.inbox.listOpen()[0].id;
    const answering = fx.inbox.answer(id, { action: 'approve' }, { kind: 'person' });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await answering).toMatchObject({
      ok: false,
      status: 504,
      code: 'extension_timeout',
      message: "Flow couldn't take that. Try again.",
    });
    expect(fx.inbox.listOpen()).toHaveLength(1);
  });

  it.each(['https://evil.example', '/x/other/p', 'javascript:alert(1)'])(
    'treats a handler navigate of %s as an error and keeps the row',
    async (navigate) => {
      fx.inbox.setHandler('flow', () => ({ resolve: 'approved', navigate }));
      await fx.inbox.raise('flow', 'Flow', shipDecision());
      const id = fx.inbox.listOpen()[0].id;
      expect(await fx.inbox.answer(id, { action: 'approve' }, { kind: 'person' })).toMatchObject({
        ok: false,
        status: 502,
      });
      expect(fx.inbox.listOpen()).toHaveLength(1);
    }
  );

  it('refuses an answer that does not fit the question', async () => {
    fx.inbox.setHandler('flow', () => ({ resolve: 'approved' }));
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const id = fx.inbox.listOpen()[0].id;
    expect(
      await fx.inbox.answer(id, { action: 'word', text: 'hi' }, { kind: 'person' })
    ).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('draws a watched chat, and drops one the extension did not start', async () => {
    fx.inbox.stop();
    fx.close();
    fx = createInboxFixture({ watchAllowed: (_ext, sessionId) => sessionId === 'started-1' });
    fx.inbox.markRunning('flow', 'Flow');
    fx.inbox.setHandler('flow', (event) =>
      event.key === 'a'
        ? { keepOpen: true, watch: { sessionId: 'started-1', label: 'Sorting 12 ideas…' } }
        : { resolve: 'answered', watch: { sessionId: 'someone-else', label: 'Sneaky' } }
    );
    await fx.inbox.raise(
      'flow',
      'Flow',
      shipDecision({
        key: 'a',
        actions: { kind: 'word', label: 'Sort them', input: { placeholder: 'x', maxLength: 10 } },
      })
    );
    await fx.inbox.raise(
      'flow',
      'Flow',
      shipDecision({
        key: 'b',
        actions: { kind: 'word', label: 'Sort them', input: { placeholder: 'x', maxLength: 10 } },
      })
    );
    const [a, b] = fx.inbox.listOpen();
    await fx.inbox.answer(a.id, { action: 'word', text: 'go' }, { kind: 'person' });
    await fx.inbox.answer(b.id, { action: 'word', text: 'go' }, { kind: 'person' });
    expect(fx.inbox.listOpen()[0].watch).toEqual({
      sessionId: 'started-1',
      label: 'Sorting 12 ideas…',
    });
    const history = fx.store.list({ limit: 25, unread: false }).notifications;
    expect(history[0].decision?.watch).toBeNull();
  });
});

describe('answering on the extension’s own page', () => {
  it('is attributed to the extension, "answered in Flow", and never offers', async () => {
    fx.inbox.setHandler('flow', () => ({
      resolve: 'approved',
      offer: { text: 'Next time?', offerId: 'o1' },
    }));
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    const id = fx.inbox.listOpen()[0].id;
    const answer = await fx.inbox.answer(
      id,
      { action: 'approve' },
      { kind: 'extension', extensionId: 'flow' }
    );
    expect(answer).toMatchObject({ ok: true, response: { resolved: true, offer: null } });
    expect(fx.history()[0].body).toBe('Ship it · answered in Flow');
    expect(fx.inbox.pendingOffers()).toEqual([]);
    const row = fx.db.select().from(extensionDecisions).all()[0];
    expect(row).toMatchObject({ resolvedBy: 'extension', resolvedByLabel: 'in Flow' });
  });
});

describe('record (decisions never asked)', () => {
  it('writes a history row only: never in "Needs you", never a push', async () => {
    await fx.inbox.record('flow', 'Flow', {
      key: 'ship:DOR-2400',
      title: 'Shipped the calmer red',
      why: 'The reviewer agent approved it, and your setting ships approved work.',
      outcome: 'approved',
      by: { kind: 'rule', label: "your 'Tell me after' setting" },
      choiceLabel: 'Shipped',
      tell: true,
    });
    expect(fx.inbox.listOpen()).toEqual([]);
    expect(fx.pendingEvents()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).not.toHaveBeenCalled();
    const [row] = fx.history();
    expect(row.body).toBe("Shipped · your 'Tell me after' setting");
    expect(row.readAt).toBeNull();
  });

  it('writes "Just do it" rows already read', async () => {
    await fx.inbox.record('flow', 'Flow', {
      key: 'k',
      title: 'Sorted 12 ideas',
      why: 'They were waiting.',
      outcome: 'answered',
      by: { kind: 'rule', label: "your 'Just do it' setting" },
    });
    expect(fx.history()[0].readAt).not.toBeNull();
  });

  it('refuses a missing, blank or 301-character why, and a missing by', async () => {
    for (const why of [undefined, '  ', 'x'.repeat(301)]) {
      await expect(
        fx.inbox.record('flow', 'Flow', {
          key: 'k',
          title: 'T',
          why: why as string,
          outcome: 'approved',
          by: { kind: 'deadline' },
        })
      ).rejects.toMatchObject({ limit: 'why' });
    }
    await expect(
      fx.inbox.record('flow', 'Flow', {
        key: 'k',
        title: 'T',
        why: 'W',
        outcome: 'approved',
        by: undefined as never,
      })
    ).rejects.toBeInstanceOf(InboxLimitError);
    expect(fx.history()).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('hides a stopped extension’s decisions and cancels their escalation', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    fx.inbox.markStopped('flow');
    expect(fx.inbox.listOpen()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).not.toHaveBeenCalled();

    fx.inbox.markRunning('flow', 'Flow');
    expect(fx.inbox.listOpen()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).toHaveBeenCalledTimes(1);
  });

  it('hides a decision whose project folder is missing and stops its escalation', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    fx.missing.add('/repos/dorkos');
    expect(fx.inbox.listOpen()).toEqual([]);
    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);
    await flush();
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).not.toHaveBeenCalled();

    fx.missing.delete('/repos/dorkos');
    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    await flush();
    expect(fx.inbox.listOpen()).toHaveLength(1);
  });

  it('shows a decision raised into a missing folder once the folder is back, and escalates it then', async () => {
    fx.missing.add('/repos/dorkos');
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    expect(fx.inbox.listOpen()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(fx.sendToAll).not.toHaveBeenCalled();

    fx.missing.delete('/repos/dorkos');
    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    await flush();
    expect(fx.inbox.listOpen()).toHaveLength(1);
    expect(fx.sendToAll).toHaveBeenCalledTimes(1);
  });

  it('cancels, with no history row, the decisions of an extension no longer installed', async () => {
    await fx.inbox.raise('flow', 'Flow', shipDecision());
    fx.inbox.cancelUndiscovered(new Set(['other']));
    const [row] = fx.db.select().from(extensionDecisions).all();
    expect(row).toMatchObject({ outcome: 'cancelled' });
    expect(row.resolvedAt).not.toBeNull();
    expect(fx.history()).toEqual([]);
  });
});
