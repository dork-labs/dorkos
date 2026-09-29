/**
 * "Next time, do this on its own?" (spec `flow-multiproject` §7.8, V9): an
 * offer shows once, only after a person's answer; "Yes" applies its settings
 * patch as the person before the extension hears it; and it cannot be used
 * twice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createInboxFixture, shipDecision, type InboxFixture } from './inbox-fixture.js';
import type {
  DecisionActionEvent,
  DecisionActionResult,
  DecisionOffer,
} from '@dorkos/extension-api/server';
import { projectSettingsStore } from '../extension-project-settings.js';

let fx: InboxFixture;
let dorkHome: string;

const OFFER = {
  text: 'Shipped. Next time, ship on its own when the reviewer agent approves?',
  offerId: 'auto-ship',
  settingsPatch: { project: '/repos/dorkos', patch: { autonomy: 'tell-me-after' } },
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-29T09:00:00.000Z') });
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-offers-'));
  fx = createInboxFixture({ dorkHome });
  fx.inbox.markRunning('flow', 'Flow');
});

afterEach(() => {
  fx.inbox.stop();
  fx.close();
  vi.useRealTimers();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

/** Raise and answer one decision whose handler offers `offer`; return its id and handler. */
async function answeredWithOffer(offer: unknown = OFFER) {
  const calls: string[] = [];
  const handler = vi.fn(async (event: DecisionActionEvent): Promise<DecisionActionResult> => {
    calls.push(event.action);
    if (event.action === 'offer') {
      const stored = await projectSettingsStore(dorkHome).read('flow', '/repos/dorkos');
      calls.push(`settings:${JSON.stringify(stored?.value ?? null)}`);
      return {
        resolve: 'approved' as const,
        message: 'Done. Change it any time in Flow settings.',
      };
    }
    return { resolve: 'approved' as const, offer: offer as DecisionOffer };
  });
  fx.inbox.setHandler('flow', handler);
  await fx.inbox.raise('flow', 'Flow', shipDecision());
  const [open] = fx.inbox.listOpen();
  await fx.inbox.answer(open.id, { action: 'approve' }, { kind: 'person' });
  return { id: open.id, handler, calls };
}

describe('the follow-up offer', () => {
  it('applies the settings patch as the person, then tells the extension, then is gone', async () => {
    const { id, calls } = await answeredWithOffer();
    const yes = await fx.inbox.answerOffer(id, true);
    expect(yes).toEqual({
      ok: true,
      message: 'Done. Change it any time in Flow settings.',
      settingsChanged: { extensionId: 'flow', extensionName: 'Flow', projectName: 'dorkos' },
    });
    // The patch was in place before the handler heard "offer".
    expect(calls).toEqual(['approve', 'offer', 'settings:{"autonomy":"tell-me-after"}']);
    const stored = await projectSettingsStore(dorkHome).read('flow', '/repos/dorkos');
    expect(stored).toMatchObject({ updatedBy: 'person', value: { autonomy: 'tell-me-after' } });

    expect(await fx.inbox.answerOffer(id, true)).toMatchObject({
      ok: false,
      status: 409,
      code: 'offer_gone',
    });
    expect(fx.inbox.pendingOffers()).toEqual([]);
  });

  it('dismisses quietly: nothing is called and nothing changes', async () => {
    const { id, calls } = await answeredWithOffer();
    expect(await fx.inbox.answerOffer(id, false)).toMatchObject({ ok: true, message: null });
    expect(calls).toEqual(['approve']);
    expect(await projectSettingsStore(dorkHome).read('flow', '/repos/dorkos')).toBeNull();
    expect(await fx.inbox.answerOffer(id, false)).toMatchObject({ code: 'offer_gone' });
  });

  it('lapses after 15 minutes', async () => {
    const { id } = await answeredWithOffer();
    vi.setSystemTime(new Date('2026-09-29T09:15:01.000Z'));
    expect(fx.inbox.pendingOffers()).toEqual([]);
    expect(await fx.inbox.answerOffer(id, true)).toMatchObject({ code: 'offer_gone' });
  });

  it('refuses a patch for a project outside the extension’s scope and writes nothing', async () => {
    fx.scope.set('flow', ['/repos/blintz']);
    const { id, calls } = await answeredWithOffer();
    expect(await fx.inbox.answerOffer(id, true)).toMatchObject({
      ok: false,
      message: "Couldn't change that. Try again.",
    });
    expect(calls).toEqual(['approve']);
    expect(await projectSettingsStore(dorkHome).read('flow', '/repos/dorkos')).toBeNull();
  });

  it('is never made for a deadline resolution', async () => {
    const handler = vi.fn().mockResolvedValue({ resolve: 'answered', offer: OFFER });
    fx.inbox.setHandler('flow', handler);
    await fx.inbox.raise('flow', 'Flow', {
      ...shipDecision(),
      actions: {
        kind: 'choice',
        choices: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        defaultChoice: 'a',
        decideBy: '2026-09-29T09:10:00.000Z',
      },
    });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fx.inbox.pendingOffers()).toEqual([]);
  });
});
