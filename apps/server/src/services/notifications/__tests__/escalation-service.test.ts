import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, runMigrations, eq, notificationDeliveries, type Db } from '@dorkos/db';
import type { EscalationDelay } from '@dorkos/shared/config-schema';
import { NotificationStore } from '../notification-store.js';
import { notificationEntry } from '../notification-registry.js';
import { EscalationService, type StandingCondition } from '../escalation-service.js';
import type { WebPushChannel, PushFanOutResult } from '../channels/web-push.js';
import type { RelayChannelDeps } from '../channels/relay.js';

let db: Db;
let store: NotificationStore;
let sendToAll: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
let delay: EscalationDelay;

/** One minute in ms — the shortest rung, used by everything below. */
const ONE_MINUTE = 60 * 1000;

/** A push channel that always lands on one device, unless a case says otherwise. */
function pushChannel(result: Partial<PushFanOutResult> = {}): WebPushChannel {
  sendToAll = vi.fn().mockResolvedValue({ delivered: 1, pruned: 0, outcomes: [], ...result });
  return { sendToAll } as unknown as WebPushChannel;
}

/** Relay seams that resolve a live, initiate-enabled Telegram chat for `agent-1`. */
function relayDeps(overrides: Partial<RelayChannelDeps> = {}): RelayChannelDeps {
  publish = vi.fn().mockResolvedValue({ deliveredTo: 1, messageId: 'm-1' });
  return {
    isRelayEnabled: () => true,
    relayCore: { publish } as unknown as RelayChannelDeps['relayCore'],
    bindingStore: {
      getAll: () => [
        {
          id: 'binding-1',
          agentId: 'agent-1',
          adapterId: 'telegram-main',
          enabled: true,
          canInitiate: true,
          notifyOnTaskComplete: true,
          chatId: 'chat-1',
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
      ],
    } as unknown as RelayChannelDeps['bindingStore'],
    bindingRouter: {
      getSessionsByBinding: () => [
        { scope: 'chat' as const, chatId: 'chat-1', sessionId: 's', lastActivityAt: 10 },
      ],
    },
    adapterManager: {
      listAdapters: () => [{ config: { id: 'telegram-main', type: 'telegram' } }],
    },
    ...overrides,
  };
}

/** Build a service over the shared fixtures. */
function buildService(
  overrides: {
    push?: WebPushChannel;
    relay?: () => RelayChannelDeps | undefined;
    reserveNote?: (agentId: string) => boolean;
    now?: () => number;
  } = {}
): EscalationService {
  return new EscalationService({
    store,
    push: overrides.push ?? pushChannel(),
    relay: overrides.relay ?? (() => relayDeps()),
    readDelay: () => delay,
    ...(overrides.reserveNote ? { reserveNote: overrides.reserveNote } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

/** The `ask.pending` payload every case arms with. */
function ask(interactionId = 'int-1') {
  return {
    sessionId: 'sess-1',
    interactionId,
    agentId: 'agent-1',
    sessionLabel: 'acme',
    summary: 'Wants to run Bash',
  };
}

/**
 * One error EPISODE on a session. `since` is what tells two episodes apart, so
 * a case about the second one varies it rather than the session id.
 */
function sessionError(since = '2026-08-20T09:00:00.000Z', sessionId = 'sess-2') {
  return { sessionId, sessionLabel: 'acme', since };
}

/** Every ledger row filed under one subject, escalations included. */
function ledgerFor(subjectKey: string): Array<{ channel: string; escalated: boolean }> {
  return store.deliveriesForSubject(subjectKey).map((row) => ({
    channel: row.channel,
    escalated:
      row.detailJson !== null &&
      (JSON.parse(row.detailJson) as { escalated?: boolean }).escalated === true,
  }));
}

/** Mark every ledger row for a subject as seen, the way a channel ack would. */
function markSeen(subjectKey: string): void {
  db.update(notificationDeliveries)
    .set({ seenAt: '2026-08-20T09:00:00.000Z' })
    .where(eq(notificationDeliveries.subjectKey, subjectKey))
    .run();
}

beforeEach(() => {
  vi.useFakeTimers();
  db = createDb(':memory:');
  runMigrations(db);
  store = new NotificationStore(db);
  delay = 1;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('arming', () => {
  /**
   * The whole ladder — the timer's key, the ledger's `subject_key`, and the
   * disarm a resolution issues — has to name one condition the same way three
   * times. It does that by having ONE builder, the registry's `dedupeKey`; this
   * asserts the timer really is filed under it, which is what makes a
   * resolution's `cancelByKey` able to find it at all.
   */
  it('files each of the three standing kinds under its registry dedupe key', () => {
    const service = buildService();
    const schedule = { taskId: 'task-1', taskName: 'Nightly', proposedBy: 'An agent' };
    const error = sessionError();

    service.arm('ask.pending', ask());
    service.arm('schedule.parked', schedule);
    service.arm('session.error', error);

    expect(service.armedSubjects().sort()).toEqual(
      [
        notificationEntry('ask.pending').dedupeKey(ask()),
        notificationEntry('schedule.parked').dedupeKey(schedule),
        notificationEntry('session.error').dedupeKey(error),
      ].sort()
    );
  });

  it('never arms while the delay is `never`', async () => {
    delay = 'never';
    const service = buildService();

    service.arm('ask.pending', ask());
    expect(service.armedSubjects()).toEqual([]);

    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('reads the knob live, so a change lands on the next arm without a restart', () => {
    const service = buildService();

    delay = 'never';
    service.arm('ask.pending', ask('int-off'));
    expect(service.armedSubjects()).toEqual([]);

    delay = 5;
    service.arm('ask.pending', ask('int-on'));
    expect(service.armedSubjects()).toEqual(['ask:int-on']);
  });

  it('silences a timer that is already running when the knob moves to `never`', async () => {
    const service = buildService();
    service.arm('ask.pending', ask());

    delay = 'never';
    await vi.advanceTimersByTimeAsync(2 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('leaves the first timer alone when the same subject is armed twice', async () => {
    const service = buildService();

    service.arm('ask.pending', ask());
    await vi.advanceTimersByTimeAsync(ONE_MINUTE / 2);
    // A seam that fires twice for one condition must not be able to push the
    // escalation further away.
    service.arm('ask.pending', ask());
    await vi.advanceTimersByTimeAsync(ONE_MINUTE / 2 + 1);

    expect(sendToAll).toHaveBeenCalledTimes(1);
  });
});

describe('cancelling', () => {
  // Each of the three cases cancels with the key its own resolution would
  // produce — `notificationEntry(kind).dedupeKey(payload)` is literally what
  // `resolveStanding` passes — so a passing case here is evidence about the
  // production disarm path and not about a key the test made up.

  it('disarms an Ask that was answered', async () => {
    const service = buildService();
    service.arm('ask.pending', ask());

    service.cancelByKey(notificationEntry('ask.pending').dedupeKey(ask()));

    expect(service.armedSubjects()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * ONE_MINUTE);
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('disarms a parked schedule that was approved or rejected', async () => {
    const service = buildService();
    const schedule = { taskId: 'task-1', taskName: 'Nightly', proposedBy: 'An agent' };
    service.arm('schedule.parked', schedule);

    service.cancelByKey(notificationEntry('schedule.parked').dedupeKey(schedule));

    await vi.advanceTimersByTimeAsync(5 * ONE_MINUTE);
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('disarms a session whose error cleared', async () => {
    const service = buildService();
    const error = sessionError();
    service.arm('session.error', error);

    service.cancelByKey(notificationEntry('session.error').dedupeKey(error));

    await vi.advanceTimersByTimeAsync(5 * ONE_MINUTE);
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('does not fire for a subject a channel already marked seen', async () => {
    const service = buildService();
    service.arm('ask.pending', ask());
    // The mark is written by hand here because NOTHING IN PRODUCTION WRITES IT
    // YET — no channel-side ack hook exists (see `wasAcknowledged`). This pins
    // the guard so that when one lands it is already honoured; it is not
    // evidence of a live path.
    store.recordDelivery({ subjectKey: 'ask:int-1', channel: 'telegram' });
    markSeen('ask:int-1');

    await vi.advanceTimersByTimeAsync(2 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('cancelling something that was never armed is not an error', () => {
    const service = buildService();
    expect(() => service.cancelByKey('ask:never-armed')).not.toThrow();
  });
});

describe('firing', () => {
  it('reaches both legs and records one ledger row each', async () => {
    const service = buildService();
    service.arm('ask.pending', ask());

    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(ledgerFor('ask:int-1')).toEqual(
      expect.arrayContaining([
        { channel: 'web_push', escalated: true },
        { channel: 'telegram', escalated: true },
      ])
    );
  });

  it('sends a payload with no tool input in it, deep-linked to the session', async () => {
    const service = buildService();
    service.arm('ask.pending', ask());

    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(sendToAll).toHaveBeenCalledWith({
      title: 'acme is waiting on your answer',
      body: 'Wants to run Bash',
      deepLink: '/session?session=sess-1',
      notificationId: 'ask:int-1',
      tier: 'blocking',
    });
  });

  it('still pushes when the chat leg is refused by the hourly allowance', async () => {
    // The two legs exist so that one being shut does not silence the other. A
    // budget that took the push leg with it would make the ceiling a gag.
    const service = buildService({ reserveNote: () => false });
    service.arm('ask.pending', ask());

    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(publish).not.toHaveBeenCalled();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(ledgerFor('ask:int-1')).toEqual([{ channel: 'web_push', escalated: true }]);
  });

  it('spends the allowance on the agent the condition names', async () => {
    const reserveNote = vi.fn().mockReturnValue(true);
    const service = buildService({ reserveNote });
    service.arm('ask.pending', ask());

    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(reserveNote).toHaveBeenCalledWith('agent-1');
  });

  it('still reaches chat when no device is subscribed', async () => {
    const service = buildService({ push: pushChannel({ delivered: 0 }) });
    service.arm('ask.pending', ask());

    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(ledgerFor('ask:int-1')).toEqual([{ channel: 'telegram', escalated: true }]);
  });

  it('records nothing when nothing could carry it', async () => {
    const service = buildService({ push: pushChannel({ delivered: 0 }), relay: () => undefined });
    service.arm('ask.pending', ask());

    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(ledgerFor('ask:int-1')).toEqual([]);
  });

  it('does not fire twice for one subject', async () => {
    const service = buildService();
    service.arm('ask.pending', ask());
    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    // Re-arming after the fire is what a rehydrating projector does. The ledger
    // is what stops it becoming a second buzz.
    service.arm('ask.pending', ask());
    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  /**
   * The regression the DOR-1387 review caught. Keyed on the session alone, the
   * ledger's "already escalated?" check answered yes forever after the first
   * episode: a session could fall over, be fixed, and fall over again, and only
   * the FIRST failure ever reached a phone. Every later one was suppressed for
   * the life of the row — up to thirty days.
   */
  it('escalates a SECOND error episode on a session that already had one', async () => {
    const service = buildService();

    const first = sessionError('2026-08-20T09:00:00.000Z');
    service.arm('session.error', first);
    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);
    expect(sendToAll).toHaveBeenCalledTimes(1);

    // The error clears, and the session falls over again a minute later.
    service.cancelByKey(notificationEntry('session.error').dedupeKey(first));
    const second = sessionError('2026-08-20T09:02:00.000Z');
    service.arm('session.error', second);
    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(sendToAll).toHaveBeenCalledTimes(2);
    expect(ledgerFor(notificationEntry('session.error').dedupeKey(first))).toHaveLength(2);
    expect(ledgerFor(notificationEntry('session.error').dedupeKey(second))).toHaveLength(2);
  });

  it('still suppresses a REPEAT of the same episode', async () => {
    // The other half of the same rule: episode identity must not cost the
    // idempotency that survives a restart.
    const service = buildService();
    const episode = sessionError();

    service.arm('session.error', episode);
    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);
    service.arm('session.error', episode);
    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(sendToAll).toHaveBeenCalledTimes(1);
  });
});

describe('re-arming on boot', () => {
  /** A condition that started standing `agoMs` before now. */
  function standing(agoMs: number, id = 'task-1'): StandingCondition {
    return {
      kind: 'schedule.parked',
      payload: { taskId: id, taskName: 'Nightly', proposedBy: 'An agent' },
      since: Date.now() - agoMs,
    };
  }

  it('escalates something that became due while the server was down', async () => {
    const service = buildService();

    service.rearmFromStandingState([standing(3 * ONE_MINUTE)]);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(ledgerFor('schedule:task-1')).toHaveLength(2);
  });

  it('gives something not yet due the REMAINDER of its delay, not a fresh one', async () => {
    delay = 5;
    const service = buildService();

    service.rearmFromStandingState([standing(4 * ONE_MINUTE)]);

    await vi.advanceTimersByTimeAsync(ONE_MINUTE / 2);
    expect(sendToAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it('leaves a condition older than the catch-up window alone', async () => {
    // A schedule parked last week is a backlog, not news, and buzzing a phone
    // about it on every restart is exactly the noise the tiering prevents.
    const service = buildService();

    service.rearmFromStandingState([standing(5 * 60 * ONE_MINUTE)]);
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('does not re-fire something the ledger says was already escalated', async () => {
    const first = buildService();
    first.rearmFromStandingState([standing(3 * ONE_MINUTE)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendToAll).toHaveBeenCalledTimes(1);

    // A second boot inside the same window, over the same database.
    const second = buildService();
    second.rearmFromStandingState([standing(3 * ONE_MINUTE)]);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('re-arms nothing at all while the delay is `never`', async () => {
    delay = 'never';
    const service = buildService();

    service.rearmFromStandingState([standing(3 * ONE_MINUTE)]);
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });
});
