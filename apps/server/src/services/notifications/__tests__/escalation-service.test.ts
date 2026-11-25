import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { EscalationDelay } from '@dorkos/shared/config-schema';
import { NotificationStore } from '../notification-store.js';
import { notificationEntry } from '../notification-registry.js';
import {
  EscalationService,
  setEscalationService,
  type StandingCondition,
} from '../escalation-service.js';
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
    now?: () => number;
  } = {}
): EscalationService {
  return new EscalationService({
    store,
    push: overrides.push ?? pushChannel(),
    relay: overrides.relay ?? (() => relayDeps()),
    readDelay: () => delay,
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
  it('never arms while the delay is `never`', async () => {
    delay = 'never';
    const service = buildService();

    service.arm('ask.pending', ask());
    expect(service.armedSubjects()).toEqual([]);

    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('silences a timer that is already running when the knob moves to `never`', async () => {
    const service = buildService();
    service.arm('ask.pending', ask());

    delay = 'never';
    await vi.advanceTimersByTimeAsync(2 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
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

  it('still pushes when the chat leg is refused', async () => {
    // The two legs exist so that one being shut does not silence the other.
    // "Agent can start conversations" OFF shuts the chat leg only.
    const service = buildService({
      relay: () =>
        relayDeps({
          bindingStore: {
            getAll: () => [
              {
                id: 'binding-1',
                agentId: 'agent-1',
                adapterId: 'telegram-main',
                enabled: true,
                canInitiate: false,
                chatId: 'chat-1',
                updatedAt: '2026-08-19T00:00:00.000Z',
              },
            ],
          } as unknown as RelayChannelDeps['bindingStore'],
        }),
    });
    service.arm('ask.pending', ask());

    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(publish).not.toHaveBeenCalled();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(ledgerFor('ask:int-1')).toEqual([{ channel: 'web_push', escalated: true }]);
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
});

/**
 * The tier gate (DOR-2517): only a `blocking` kind may escalate. Before
 * `extension.approval` every standing kind happened to be `blocking`, so
 * nothing enforced it, and a `notable` kind raised through `raiseStanding`
 * armed a timer and pushed to a phone like the rest.
 */
describe('the tier gate', () => {
  const waitingExtension = {
    id: 'flow',
    name: 'Flow',
    version: '1.0.0',
    path: '/home/me/.dork/plugins/flow/.dork/extensions/flow',
    plugin: 'flow',
    sourceLabel: 'flow plugin · dork-labs/marketplace',
    why: 'You installed the flow plugin. It runs as you.',
    runsInServer: false,
    adds: null,
    added: null,
  };

  afterEach(() => {
    setEscalationService(null);
  });

  it('arms no timer and makes no push call for a notable kind armed directly', async () => {
    const service = buildService();

    service.arm('extension.approval', waitingExtension);

    expect(service.armedSubjects()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);
    expect(sendToAll).not.toHaveBeenCalled();
  });
});
