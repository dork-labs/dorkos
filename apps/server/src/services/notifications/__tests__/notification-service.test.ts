import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, runMigrations, count, notifications, type Db } from '@dorkos/db';
import { NotificationDTOSchema } from '@dorkos/shared/notification-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import { NotificationStore, NOTIFICATION_MAX_ROWS } from '../notification-store.js';
import { NotificationService } from '../notification-service.js';
import type { RelayChannelDeps } from '../channels/relay.js';

/** One captured SSE broadcast: the name, the payload, and the audience it named. */
type Broadcast = [string, unknown, ((principal: { kind: string }) => boolean) | undefined];

let db: Db;
let store: NotificationStore;
let sent: Broadcast[] = [];

/** Every broadcast of one event name, in order. */
function sentAs(name: string): Broadcast[] {
  return sent.filter(([eventName]) => eventName === name);
}

/** How many rows the table actually holds. */
function rowCount(): number {
  const [row] = db.select({ value: count() }).from(notifications).all();
  return row?.value ?? 0;
}

/** The turn-completed payload, varied per call so nothing dedupes by accident. */
function turn(at: string) {
  return { sessionId: 'sess-1', sessionLabel: 'acme', completedAt: at, agentId: 'agent-1' };
}

/** A successful run, which is the opt-in relay case. */
function run(id: string, status: 'completed' | 'failed' = 'completed') {
  return {
    runId: id,
    taskId: 'task-1',
    taskName: 'Nightly digest',
    agentId: 'agent-1',
    status,
    channelMessage: `message for ${id}`,
  };
}

/** Relay seams that resolve a live, opted-in Telegram chat. */
function relayDeps(overrides: Partial<RelayChannelDeps> = {}): RelayChannelDeps {
  return {
    isRelayEnabled: () => true,
    relayCore: { publish: vi.fn().mockResolvedValue({ deliveredTo: 1, messageId: 'm-1' }) },
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

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  store = new NotificationStore(db);
  sent = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data, audience) => {
    sent.push([name, data, audience as Broadcast[2]]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NotificationService.notify', () => {
  it('stores an event notification and announces it', async () => {
    const service = new NotificationService(store);
    const result = await service.notify('turn.completed', turn('2026-08-20T00:00:00.000Z'));

    expect(result.deduped).toBe(false);
    expect(NotificationDTOSchema.safeParse(result.notification).success).toBe(true);
    expect(result.notification?.title).toBe('acme finished');
    expect(result.notification?.readAt).toBeUndefined();

    const announced = sentAs('notification');
    expect(announced).toHaveLength(1);
    expect((announced[0][1] as { notification: { id: string } }).notification.id).toBe(
      result.notification?.id
    );
  });

  it('addresses the announcement rather than broadcasting it to everyone', async () => {
    const service = new NotificationService(store);
    await service.notify('turn.completed', turn('2026-08-20T00:00:00.000Z'));

    const [, , audience] = sentAs('notification')[0];
    expect(typeof audience).toBe('function');
    const predicate = audience as (p: { kind: string }) => boolean;
    expect(predicate({ kind: 'operator' })).toBe(true);
    expect(predicate({ kind: 'agent' })).toBe(false);
  });

  it('drops the same notification raised twice inside the window', async () => {
    const service = new NotificationService(store);
    const payload = turn('2026-08-20T00:00:00.000Z');

    const first = await service.notify('turn.completed', payload);
    const second = await service.notify('turn.completed', payload);

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.notification).toBeNull();
    expect(service.list({ limit: 25, unread: false }).notifications).toHaveLength(1);
  });

  it('raises a second notification once the window has passed', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
      const service = new NotificationService(store);
      const payload = turn('2026-08-20T00:00:00.000Z');
      await service.notify('turn.completed', payload);

      vi.setSystemTime(new Date('2026-08-20T00:06:00.000Z'));
      const second = await service.notify('turn.completed', payload);
      expect(second.deduped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never notifies the operator about their own action, but still keeps the history', async () => {
    const service = new NotificationService(store);
    const result = await service.notify('turn.completed', turn('2026-08-20T00:00:00.000Z'), {
      actorPrincipal: { kind: 'operator' },
    });

    // The row exists — history is history — but it arrives already read, so
    // nothing lights up for something the person just did themselves.
    expect(result.notification).not.toBeNull();
    expect(result.notification?.readAt).toBeDefined();
    expect(service.list({ limit: 25, unread: false }).unreadCount).toBe(0);
  });

  it('does not reach out of the app about the operator own action', async () => {
    const deps = relayDeps();
    const service = new NotificationService(store, { relay: () => deps });
    await service.notify('run.completed', run('run-1', 'failed'), {
      actorPrincipal: { kind: 'operator' },
      relay: { fromPrincipal: 'relay.system.tasks.notifier' },
    });
    expect(deps.relayCore!.publish).not.toHaveBeenCalled();
  });

  it('sends a failed run out even when the binding never opted in', async () => {
    const deps = relayDeps({
      bindingStore: {
        getAll: () => [
          {
            id: 'binding-1',
            agentId: 'agent-1',
            adapterId: 'telegram-main',
            enabled: true,
            canInitiate: true,
            notifyOnTaskComplete: false,
            chatId: 'chat-1',
          },
        ],
      } as unknown as RelayChannelDeps['bindingStore'],
    });
    const service = new NotificationService(store, { relay: () => deps });

    const result = await service.notify('run.completed', run('run-1', 'failed'), {
      relay: { fromPrincipal: 'relay.system.tasks.notifier' },
    });

    expect(deps.relayCore!.publish).toHaveBeenCalledWith(
      'relay.human.telegram.telegram-main.chat-1',
      'message for run-1',
      expect.objectContaining({ from: 'relay.system.tasks.notifier' })
    );
    expect(result.relay).toMatchObject({ ok: true, surface: 'integration' });
  });

  it('keeps a successful run to itself when the binding never opted in', async () => {
    const deps = relayDeps({
      bindingStore: {
        getAll: () => [
          {
            id: 'binding-1',
            agentId: 'agent-1',
            adapterId: 'telegram-main',
            enabled: true,
            canInitiate: true,
            notifyOnTaskComplete: false,
            chatId: 'chat-1',
          },
        ],
      } as unknown as RelayChannelDeps['bindingStore'],
    });
    const service = new NotificationService(store, { relay: () => deps });

    const result = await service.notify('run.completed', run('run-1', 'completed'), {
      relay: { fromPrincipal: 'relay.system.tasks.notifier' },
    });

    expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    expect(result.relay).toMatchObject({ ok: false, reason: 'NOT_OPTED_IN' });
    // The row is still written: the inbox records the run whether or not any
    // chat could carry it.
    expect(result.notification).not.toBeNull();
  });

  it('records a ledger row naming the channel a delivery actually used', async () => {
    const service = new NotificationService(store, { relay: () => relayDeps() });
    const result = await service.notify('run.completed', run('run-1', 'failed'), {
      relay: { fromPrincipal: 'relay.system.tasks.notifier' },
    });

    const ledger = store.deliveriesFor(result.notification!.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].channel).toBe('telegram');
    expect(ledger[0].detail).toMatchObject({ surface: 'integration', chatId: 'chat-1' });
  });

  it('writes nothing at all for a note the hourly allowance refused', async () => {
    const service = new NotificationService(store);
    const result = await service.notify(
      'agent.note',
      { agentId: 'agent-1', agentName: 'Ana', message: 'hello' },
      { delivered: { ok: false, reason: 'RATE_LIMITED' } }
    );

    expect(result.notification).toBeNull();
    expect(service.list({ limit: 25, unread: false }).notifications).toHaveLength(0);
    expect(sentAs('notification')).toHaveLength(0);
  });

  it('writes nothing at all for a note the operator switched off', async () => {
    // "Agent can start conversations" is OFF on the binding this resolved to.
    // Honouring that on Telegram while still writing an inbox row would read the
    // switch as being about Telegram; it is about being interrupted.
    const service = new NotificationService(store);
    const result = await service.notify(
      'agent.note',
      { agentId: 'agent-1', agentName: 'Ana', message: 'hello' },
      {
        delivered: {
          ok: false,
          reason: 'INITIATE_NOT_ALLOWED',
          bindingId: 'binding-1',
          adapterId: 'telegram-main',
        },
      }
    );

    expect(result.notification).toBeNull();
    expect(service.list({ limit: 25, unread: false }).notifications).toHaveLength(0);
    expect(sentAs('notification')).toHaveLength(0);
  });

  it('still writes a row when the note simply could not be delivered', async () => {
    // The contrast that makes the two cases above meaningful: nobody refused
    // this, the install just has no integration. The news still happened, so the
    // inbox is where it is found.
    const service = new NotificationService(store);
    const result = await service.notify(
      'agent.note',
      { agentId: 'agent-1', agentName: 'Ana', message: 'hello' },
      { delivered: { ok: false, reason: 'NO_BINDING', availableChannels: [] } }
    );

    expect(result.notification).not.toBeNull();
    expect(sentAs('notification')).toHaveLength(1);
  });

  it('records a second delivery of a note it has already said once', async () => {
    // Saying the same thing twice is suppressed; SENDING it twice is not the
    // same event, and the ledger is the record of what reached somebody.
    const service = new NotificationService(store);
    const payload = { agentId: 'agent-1', agentName: 'Ana', message: 'hello' };
    const landed = (entryId: string) =>
      ({ ok: true, surface: 'dorkos-dm', roomId: 'room-1', entryId }) as const;

    const first = await service.notify('agent.note', payload, { delivered: landed('entry-1') });
    const second = await service.notify('agent.note', payload, { delivered: landed('entry-2') });

    expect(second.deduped).toBe(true);
    expect(second.notification).toBeNull();
    expect(service.list({ limit: 25, unread: false }).notifications).toHaveLength(1);

    const ledger = store.deliveriesFor(first.notification!.id);
    expect(ledger).toHaveLength(2);
    expect(ledger.map((row) => (row.detail as { entryId: string }).entryId)).toEqual([
      'entry-1',
      'entry-2',
    ]);
  });

  it('records a delivery the caller already made rather than repeating it', async () => {
    const deps = relayDeps();
    const service = new NotificationService(store, { relay: () => deps });
    const result = await service.notify(
      'agent.note',
      { agentId: 'agent-1', agentName: 'Ana', message: 'hello' },
      { delivered: { ok: true, surface: 'dorkos-dm', roomId: 'room-1', entryId: 'entry-1' } }
    );

    expect(deps.relayCore!.publish).not.toHaveBeenCalled();
    expect(store.deliveriesFor(result.notification!.id)).toEqual([
      {
        channel: 'in_app',
        detail: { surface: 'dorkos-dm', roomId: 'room-1', entryId: 'entry-1' },
      },
    ]);
  });
});

describe('NotificationService.resolveStanding', () => {
  it('writes nothing while a condition stands, and one row when it ends', async () => {
    const service = new NotificationService(store);
    // Nothing has been raised — a standing kind has no notify() path at all, so
    // the history is empty until something resolves.
    expect(service.list({ limit: 25, unread: false }).notifications).toHaveLength(0);

    const result = await service.resolveStanding(
      'ask.pending',
      {
        sessionId: 'sess-1',
        interactionId: 'int-1',
        sessionLabel: 'acme',
        summary: 'Wants to run Bash',
      },
      { outcome: 'answered' }
    );

    expect(result.notification?.resolvedAt).toBeDefined();
    expect(result.notification?.outcome).toBe('answered');
    expect(service.list({ limit: 25, unread: false }).notifications).toHaveLength(1);
  });

  it('leaves an unanswered ask unread, and an answered one read', async () => {
    const service = new NotificationService(store);
    await service.resolveStanding(
      'ask.pending',
      { sessionId: 's1', interactionId: 'int-1', sessionLabel: 'acme', summary: 'a' },
      { outcome: 'expired' }
    );
    await service.resolveStanding(
      'ask.pending',
      { sessionId: 's2', interactionId: 'int-2', sessionLabel: 'acme', summary: 'b' },
      { outcome: 'answered' }
    );

    const listed = service.list({ limit: 25, unread: false });
    const expired = listed.notifications.find((n) => n.outcome === 'expired');
    const answered = listed.notifications.find((n) => n.outcome === 'answered');
    expect(expired?.readAt).toBeUndefined();
    expect(answered?.readAt).toBeDefined();
    expect(listed.unreadCount).toBe(1);
  });

  it('rebuilds the approve and reject buttons on a stored parked schedule', async () => {
    const service = new NotificationService(store);
    const result = await service.resolveStanding(
      'schedule.parked',
      { taskId: 'task-1', taskName: 'Nightly digest', proposedBy: 'An agent' },
      { outcome: 'approved' }
    );

    const [stored] = store.byIds([result.notification!.id]);
    expect(stored.actions?.map((a) => a.id)).toEqual(['approve', 'reject']);
  });
});

describe('read state', () => {
  it('marks one read, tells every window, and reports the new count', async () => {
    const service = new NotificationService(store);
    const a = await service.notify('turn.completed', turn('2026-08-20T00:00:00.000Z'));
    await service.notify('turn.completed', turn('2026-08-20T00:01:00.000Z'));

    const response = service.markRead(a.notification!.id);
    expect(response).toEqual({ ok: true, marked: 1, unreadCount: 1 });

    const [, payload] = sentAs('notification_read')[0];
    expect(payload).toMatchObject({ ids: [a.notification!.id], all: false, unreadCount: 1 });
  });

  it('marks a notification read only once', async () => {
    const service = new NotificationService(store);
    const a = await service.notify('turn.completed', turn('2026-08-20T00:00:00.000Z'));
    service.markRead(a.notification!.id);
    expect(service.markRead(a.notification!.id)).toEqual({ ok: true, marked: 0, unreadCount: 0 });
  });

  it('marks everything read in one go', async () => {
    const service = new NotificationService(store);
    await service.notify('turn.completed', turn('2026-08-20T00:00:00.000Z'));
    await service.notify('turn.completed', turn('2026-08-20T00:01:00.000Z'));

    expect(service.markAllRead()).toEqual({ ok: true, marked: 2, unreadCount: 0 });
    const [, payload] = sentAs('notification_read')[0];
    expect(payload).toMatchObject({ all: true, unreadCount: 0 });
  });

  it('says nothing when there was nothing to mark', async () => {
    const service = new NotificationService(store);
    expect(service.markAllRead()).toEqual({ ok: true, marked: 0, unreadCount: 0 });
    expect(sentAs('notification_read')).toHaveLength(0);
  });
});

describe('prune on write', () => {
  /**
   * A store with a tiny cap, so the eviction RULES can be proven in a handful of
   * writes. The real cap is exercised once, at the bottom, against the constant
   * the product actually ships.
   */
  function cappedAt(maxRows: number) {
    const small = new NotificationStore(db, { maxRows });
    return { store: small, service: new NotificationService(small) };
  }

  it('spends the overflow on repetitive history before touching anything else', async () => {
    // The failure this exists to stop: an afternoon of agent work silently
    // evicting the rows somebody actually goes looking for a week later.
    const { store: small, service } = cappedAt(4);
    const deadLetter = await service.notify('dead-letter.created', {
      deadLetterId: 'dl-1',
      reason: 'no endpoint accepted it',
    });
    const update = await service.notify('update.installed', {
      version: '0.61.0',
      previousVersion: '0.60.0',
    });

    for (let i = 0; i < 4; i += 1) {
      await service.notify('turn.completed', turn(`2026-08-20T01:00:0${i}.000Z`));
    }

    expect(rowCount()).toBe(4);
    // Both survive, even though they are the two OLDEST rows in the table.
    expect(small.byIds([deadLetter.notification!.id, update.notification!.id])).toHaveLength(2);
  });

  it('falls back to plain age when high-churn history is not what filled the table', async () => {
    // Nothing cheap to give up, so the cap wins over the preference and the
    // oldest row of any kind goes.
    const { store: small, service } = cappedAt(3);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await service.notify('dead-letter.created', {
        deadLetterId: `dl-${i}`,
        reason: 'no endpoint accepted it',
      });
      if (result.notification) ids.push(result.notification.id);
    }

    expect(rowCount()).toBe(3);
    expect(small.byIds([ids[0]])).toHaveLength(0);
  });

  it('drops the oldest rows, not the newest', async () => {
    const { store: small, service } = cappedAt(3);
    const first = await service.notify('turn.completed', turn('2026-08-20T00:00:00.000Z'));
    for (let i = 1; i <= 3; i += 1) {
      await service.notify('turn.completed', turn(`2026-08-20T01:00:0${i}.000Z`));
    }
    expect(small.byIds([first.notification!.id])).toHaveLength(0);
  });

  it('keeps the table at the shipped cap however far a burst overshoots it', async () => {
    // The one test that pays for the real constant, so the default the product
    // ships is proven rather than assumed from the small-cap cases above.
    const service = new NotificationService(store);
    for (let i = 0; i <= NOTIFICATION_MAX_ROWS; i += 1) {
      await service.notify(
        'turn.completed',
        turn(`2026-08-20T00:00:${String(i).padStart(2, '0')}.000Z`)
      );
    }

    expect(rowCount()).toBe(NOTIFICATION_MAX_ROWS);
  });
});
