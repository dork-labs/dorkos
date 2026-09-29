/**
 * A usage limit is told once per account episode, as `account.limited`, and
 * never as a `session.error` or its escalation (spec `claude-account-fleet` D4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { notifications, sessionMetadata, type Db } from '@dorkos/db';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import type { SessionLimit } from '@dorkos/shared/schemas';
import { SessionStateProjector } from '../../session/session-state-projector.js';
import { setAgentPathLookup, resetAgentPathLookup } from '../../mesh/agent-path-lookup.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { setAccountUsageStore } from '../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../core/usage/account-usage-store.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../session/fleet/session-limit-store.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationService, setNotificationService } from '../notification-service.js';
import { notifyAutoMoveFailed, watchSessionLifecycle } from '../emitters/session-lifecycle.js';
import { notificationEntry } from '../notification-registry.js';

const armEscalation = vi.hoisted(() => vi.fn());
vi.mock('../escalation-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../escalation-service.js')>()),
  armEscalation,
}));

const LIMIT: SessionLimit = {
  accountId: 'work',
  window: 'seven_day',
  resetsAt: '2026-09-28T20:00:00.000Z',
  since: '2026-09-26T10:00:00.000Z',
  plan: { mode: 'ask' },
  scope: 'account',
  state: 'limited',
};

let db: Db;
let service: NotificationService;
let limits: SessionLimitStore;
let unsubscribe: () => void;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** One session's turn that stops on an error, carrying `limit` when given. */
function failTurn(
  sessionId: string,
  limit: SessionLimit | null,
  accountPath: string | null = null
): SessionStateProjector {
  const projector = new SessionStateProjector(sessionId);
  projector.cwd = `/Users/dev/${sessionId}`;
  projector.ingest({ type: 'turn_start' } as never);
  projector.ingest({
    type: 'error',
    message: limit ? "You've hit your weekly limit" : 'boom',
    code: limit ? 'rate_limit' : 'server_error',
  } as never);
  if (limit) {
    // The runtime keeps the row mid-turn, after the turn_start that clears it.
    limits.upsert({ sessionId, limit, scope: 'account', accountPath });
    projector.ingest({ type: 'status_change', status: { limit } } as never);
  }
  projector.ingest({ type: 'turn_end' } as never);
  return projector;
}

function rows() {
  return service.list({ limit: 50, unread: false }).notifications;
}

beforeEach(() => {
  db = createTestDb();
  service = new NotificationService(new NotificationStore(db));
  setNotificationService(service);
  limits = new SessionLimitStore(db);
  setSessionLimitStore(limits);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  setAgentPathLookup({ getByPath: () => undefined });
  setAccountUsageStore({
    peek: (runtime: string, ids: readonly string[]) =>
      runtime === 'claude-code' && ids.includes('work')
        ? [{ accountId: 'work', label: 'Work' }]
        : runtime === 'claude-code' && ids.includes('default')
          ? [{ accountId: 'default', label: null }]
          : runtime === 'codex' && ids.includes('default')
            ? [{ accountId: 'default', label: "Main (this computer's sign-in)" }]
            : [],
    usageAtPath: () => null,
  } as unknown as AccountUsageStore);
  armEscalation.mockClear();
  unsubscribe = watchSessionLifecycle();
});

afterEach(() => {
  unsubscribe();
  setNotificationService(null);
  setSessionLimitStore(undefined);
  setAccountUsageStore(undefined);
  resetAgentPathLookup();
  vi.restoreAllMocks();
});

describe('account.limited', () => {
  it('three sessions on one account hitting one limit make exactly one notification', async () => {
    const projectors = ['s-1', 's-2', 's-3'].map((id) => failTurn(id, LIMIT));
    await flush();
    expect(projectors.map((p) => p.getStatus().lifecycle)).toEqual(['error', 'error', 'error']);

    // Each session's next turn clears the error: still no session.error row.
    for (const projector of projectors) {
      projector.ingest({ type: 'turn_start' } as never);
      projector.ingest({ type: 'turn_end' } as never);
    }
    await flush();

    const all = rows();
    const limited = all.filter((r) => r.kind === 'account.limited');
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ tier: 'notable', subject: { type: 'session', id: 's-1' } });
    expect(limited[0]!.title).toMatch(/^Work is out until /);
    expect(all.filter((r) => r.kind === 'session.error')).toHaveLength(0);
    expect(armEscalation).not.toHaveBeenCalled();
  });

  it('a non-limit error still raises session.error', async () => {
    failTurn('s-plain', null);
    await flush();
    expect(armEscalation).toHaveBeenCalledWith(
      'session.error',
      expect.objectContaining({ sessionId: 's-plain' })
    );
    expect(rows().filter((r) => r.kind === 'account.limited')).toHaveLength(0);
  });

  it('never shows a raw account id when the account has no usage label', async () => {
    failTurn('s-default', { ...LIMIT, accountId: 'default' });
    await flush();
    const [row] = rows().filter((r) => r.kind === 'account.limited');
    expect(row!.title).toMatch(/^Your Claude account is out until /);
  });

  it('keeps an unregistered account’s folder out of the stored notification', async () => {
    failTurn('s-side', { ...LIMIT, accountId: null }, '/Users/dev/.claude-side');
    await flush();
    const [row] = rows().filter((r) => r.kind === 'account.limited');
    expect(row!.title).toMatch(/^Your Claude account is out until /);
    expect(JSON.stringify(row)).not.toContain('.claude-side');
    // The stored payload, which rebuilds the row on read, carries a hash of it.
    const stored = db.select().from(notifications).all();
    expect(stored.map((n) => n.dataJson).join('\n')).not.toContain('.claude-side');
    expect(JSON.parse(stored[0]!.dataJson!)).toMatchObject({ accountRef: expect.any(String) });
  });

  it('names a Codex or OpenCode limit by its own runtime’s account, and keeps its episode apart from Claude’s', async () => {
    runtimeRegistry.setDb(db);
    const bind = (sessionId: string, runtime: string) =>
      db
        .insert(sessionMetadata)
        .values({ sessionId, runtime, createdAt: new Date().toISOString() })
        .run();
    bind('s-codex', 'codex');
    bind('s-opencode', 'opencode');
    const defaultLimit = { ...LIMIT, accountId: 'default' };

    failTurn('s-claude', defaultLimit);
    failTurn('s-codex', defaultLimit);
    failTurn('s-opencode', { ...defaultLimit, window: 'unknown', resetsAt: null });
    await flush();

    const limited = rows().filter((r) => r.kind === 'account.limited');
    const titleOf = (id: string) => limited.find((r) => r.subject?.id === id)?.title;
    // Same id, same window and reset on two runtimes: two accounts, two notifications.
    expect(limited).toHaveLength(3);
    expect(titleOf('s-claude')).toMatch(/^Your Claude account is out until /);
    expect(titleOf('s-codex')).toMatch(/^Main \(this computer's sign-in\) is out until /);
    expect(titleOf('s-opencode')).toBe('Your OpenCode account hit its usage limit');
  });

  it('names an unknown reset by the window, and keys an unregistered account by its folder hash', () => {
    const entry = notificationEntry('account.limited');
    const payload = {
      sessionId: 's-1',
      sessionLabel: 'acme',
      accountId: null,
      accountRef: '3f2a9c01b7de',
      accountLabel: 'Your Claude account',
      window: 'seven_day',
      resetsAt: null,
      since: '2026-09-26T10:42:00.000Z',
    };
    expect(entry.title(payload)).toBe('Your Claude account hit its weekly limit');
    expect(entry.dedupeKey(payload)).toBe('account-limited:3f2a9c01b7de:seven_day:2026-09-26T10');
    expect(entry.relay).toBe('never');
  });

  it('tells the person again, beside the first notice, when an automatic move could not happen', async () => {
    failTurn('s-1', LIMIT);
    await flush();
    notifyAutoMoveFailed('s-1', '/Users/dev/s-1', LIMIT);
    await flush();
    // Once per session, whatever retries it.
    notifyAutoMoveFailed('s-1', '/Users/dev/s-1', LIMIT);
    await flush();

    const limited = rows().filter((r) => r.kind === 'account.limited');
    expect(limited).toHaveLength(2);
    const repeat = limited.find((r) => r.body !== undefined && r.body !== null);
    expect(repeat?.body).toBe(
      'DorkOS could not move it automatically, so the session is waiting for you.'
    );
  });
});
