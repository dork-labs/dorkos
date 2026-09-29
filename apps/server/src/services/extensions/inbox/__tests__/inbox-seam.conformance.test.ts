/**
 * The inbox seam through the real `createDataProviderContext`, with two
 * fixture extensions side by side (spec `flow-multiproject` §10.4): keys are
 * namespaced, raising twice keeps one open row, `cleared` writes one history
 * row, a slow handler keeps its row, limits throw, and a question's deadline
 * reaches only the extension that asked, as the agent's pick.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extensionDecisions } from '@dorkos/db';
import { createDataProviderContext } from '../../extension-server-api-factory.js';
import { createInboxFixture, flush, type InboxFixture } from './inbox-fixture.js';
import { heard, raiseAll, register } from './fixtures/inbox-fixture.js';

const ONE_MINUTE = 60_000;
let fx: InboxFixture;

/** The real context for one fixture extension. */
function contextFor(extensionId: string, extensionName: string) {
  return createDataProviderContext({
    extensionId,
    extensionName,
    extensionDir: '/fake',
    dorkHome: '/tmp/dork-home-unused',
  });
}

/** A router stand-in: the fixture only mounts one route on it. */
const router = () => ({ put: vi.fn() }) as never;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-29T09:00:00.000Z') });
  fx = createInboxFixture();
  heard.length = 0;
});

afterEach(() => {
  fx.inbox.stop();
  fx.close();
  vi.useRealTimers();
});

describe('the inbox seam, through the real context', () => {
  it('runs the fixture end to end for two extensions without either touching the other', async () => {
    const alpha = contextFor('alpha', 'Alpha');
    const beta = contextFor('beta', 'Beta');
    const stopAlpha = register(router(), alpha.ctx);
    register(router(), beta.ctx);
    fx.inbox.markRunning('alpha', 'Alpha');
    fx.inbox.markRunning('beta', 'Beta');

    const deadline = new Date(Date.now() + 10 * ONE_MINUTE).toISOString();
    await raiseAll(alpha.ctx, deadline);
    await raiseAll(beta.ctx, deadline);

    // Dedupe: two raises of `ship`, one open row; a record never shows as open.
    const alphaOpen = await alpha.ctx.inbox.list();
    expect(alphaOpen.map((decision) => decision.key).sort()).toEqual([
      'linear-down',
      'question',
      'ship',
    ]);
    expect(alphaOpen.find((decision) => decision.key === 'ship')?.title).toBe('Ship it now?');

    // Namespacing: beta settling `ship` settles its own, never alpha's.
    expect(await beta.ctx.inbox.resolve('ship', { outcome: 'cleared' })).toBe(true);
    expect((await alpha.ctx.inbox.list()).some((decision) => decision.key === 'ship')).toBe(true);

    // `cleared` writes one history row each.
    expect(await alpha.ctx.inbox.resolve('linear-down', { outcome: 'cleared' })).toBe(true);
    expect(fx.history().filter((row) => row.body === 'Resolved on its own')).toHaveLength(2);

    // A person answers alpha's `ship` in the bell: the handler hears it, the
    // offer is made, and a Yes reaches the handler as `offer`.
    const ship = fx.inbox.listOpen('alpha').find((decision) => decision.key === 'ship');
    expect(ship).toBeDefined();
    const answer = await fx.inbox.answer(ship!.id, { action: 'approve' }, { kind: 'person' });
    expect(answer).toMatchObject({
      ok: true,
      response: { resolved: true, offer: { text: 'Next time, do this on its own?' } },
    });
    expect(await fx.inbox.answerOffer(ship!.id, true)).toMatchObject({
      ok: true,
      message: 'Done.',
    });

    // The deadline reaches each extension that asked, as the agent's pick.
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();
    const atDeadline = heard.filter((entry) => entry.decidedBy === 'deadline');
    expect(atDeadline.map((entry) => entry.extension).sort()).toEqual(['alpha', 'beta']);
    expect(atDeadline.every((entry) => entry.choiceId === 'keep')).toBe(true);

    // After shutdown alpha's handler is gone: an answer finds nobody to hear it.
    stopAlpha();
    alpha.releaseListeners();
    await alpha.ctx.inbox.raise({
      key: 'after',
      title: 'After?',
      why: 'Raised after the handler went.',
      actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
    });
    const after = fx.inbox.listOpen('alpha').find((decision) => decision.key === 'after');
    expect(
      await fx.inbox.answer(after!.id, { action: 'approve' }, { kind: 'person' })
    ).toMatchObject({
      ok: false,
      code: 'not_running',
    });
  });

  it('keeps the row when the handler takes longer than 5 seconds', async () => {
    const alpha = contextFor('alpha', 'Alpha');
    register(router(), alpha.ctx);
    fx.inbox.markRunning('alpha', 'Alpha');
    await alpha.ctx.inbox.raise({
      key: 'slow',
      title: 'Slow?',
      why: 'The handler never answers.',
      actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
    });
    const [slow] = fx.inbox.listOpen('alpha');
    const answering = fx.inbox.answer(slow.id, { action: 'approve' }, { kind: 'person' });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await answering).toMatchObject({ ok: false, status: 504 });
    const open = fx.db
      .select()
      .from(extensionDecisions)
      .all()
      .filter((row) => row.resolvedAt === null);
    expect(open).toHaveLength(1);
  });

  it('throws on a broken limit or an outside link, and writes nothing', async () => {
    const alpha = contextFor('alpha', 'Alpha');
    await expect(
      alpha.ctx.inbox.raise({
        key: 'no-why',
        title: 'No reason',
        why: '',
        actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
      })
    ).rejects.toMatchObject({ code: 'inbox_limit', limit: 'why' });
    await expect(
      alpha.ctx.inbox.raise({
        key: 'far',
        title: 'Far away',
        why: 'Somewhere else.',
        link: 'https://evil.example',
        actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
      })
    ).rejects.toMatchObject({ code: 'inbox_link' });
    expect(fx.db.select().from(extensionDecisions).all()).toEqual([]);
  });
});
