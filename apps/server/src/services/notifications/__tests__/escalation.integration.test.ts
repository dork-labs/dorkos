/**
 * The escalation ladder, end to end from the seam that starts it.
 *
 * The unit tests next door drive {@link EscalationService} directly. This one
 * proves the WIRING: a real projector raises a real Ask, the real emitter arms a
 * real timer, and the delay elapsing reaches the channels exactly once — and
 * answering first reaches them not at all. That is the difference between "the
 * ladder works" and "the ladder is plugged in".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { EscalationDelay } from '@dorkos/shared/config-schema';
import { SessionStateProjector } from '../../session/session-state-projector.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationService, setNotificationService } from '../notification-service.js';
import { watchAskResolution } from '../emitters/ask-resolution.js';
import { watchSessionLifecycle } from '../emitters/session-lifecycle.js';
import { EscalationService, setEscalationService } from '../escalation-service.js';
import type { WebPushChannel } from '../channels/web-push.js';

const ONE_MINUTE = 60 * 1000;

let db: Db;
let store: NotificationStore;
let sendToAll: ReturnType<typeof vi.fn>;
let unsubscribes: Array<() => void> = [];
let delay: EscalationDelay;

/** Let the fire-and-forget microtasks settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Every escalation the ledger recorded for one subject. */
function escalations(subjectKey: string): Array<{ channel: string }> {
  return store
    .deliveriesForSubject(subjectKey)
    .filter(
      (row) =>
        row.detailJson !== null &&
        (JSON.parse(row.detailJson) as { escalated?: boolean }).escalated === true
    )
    .map((row) => ({ channel: row.channel }));
}

/** Raise a real Ask on a real projector. */
function askOn(projector: SessionStateProjector, id: string): void {
  projector.ingest({
    type: 'approval_required',
    id,
    toolName: 'Bash',
    displayName: 'Run a shell command',
    input: 'rm -rf ./build',
    hasSuggestions: false,
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  db = createTestDb();
  store = new NotificationStore(db);
  setNotificationService(new NotificationService(store));

  sendToAll = vi.fn().mockResolvedValue({ delivered: 1, pruned: 0, outcomes: [] });
  delay = 2;
  setEscalationService(
    new EscalationService({
      store,
      push: { sendToAll } as unknown as WebPushChannel,
      // No chat integration on this install, which is the stock state — the push
      // leg alone has to carry it.
      relay: () => undefined,
      readDelay: () => delay,
    })
  );

  unsubscribes = [watchAskResolution(), watchSessionLifecycle()];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});

afterEach(() => {
  for (const off of unsubscribes) off();
  setEscalationService(null);
  setNotificationService(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('an Ask nobody answers', () => {
  it('reaches the phone exactly once, and leaves exactly one escalation row', async () => {
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();

    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(escalations('ask:int-1')).toEqual([{ channel: 'web_push' }]);
  });

  it('carries a title and a deep link, and never the tool input', async () => {
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);

    const payload = sendToAll.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: 'acme is waiting on your answer',
      body: 'Run a shell command',
      deepLink: '/session?session=sess-1',
      tier: 'blocking',
    });
    // A push is decrypted by a browser and drawn by the OS, often on a locked
    // screen. A proposed shell command has no business being there.
    expect(JSON.stringify(payload)).not.toContain('rm -rf');
  });
});

describe('an Ask somebody answers', () => {
  it('never escalates when the answer lands inside the delay', async () => {
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    projector.ingest({
      type: 'interaction_resolved',
      id: 'int-1',
      resolution: 'answered',
      at: Date.now(),
    } as never);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
    expect(escalations('ask:int-1')).toEqual([]);
  });

  it('stops escalating even when the Ask ended because nobody answered', async () => {
    // An expiry is not an acknowledgement, but it IS the condition ending: the
    // agent is no longer waiting, so a phone ping about it would arrive about
    // something that is over.
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    projector.ingest({
      type: 'interaction_resolved',
      id: 'int-1',
      resolution: 'expired',
      at: Date.now(),
    } as never);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });
});

describe('the knob', () => {
  it('escalates nothing at all while it is set to `never`', async () => {
    delay = 'never';
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });
});
