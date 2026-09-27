/**
 * A hard usage limit on the session (spec `claude-account-fleet` D4): the
 * `rate_limit` assistant error is no longer dropped, and a turn that stopped on
 * a limit yields one `session_status { limit }`, kept in `session_limits`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentSession, ToolState } from '../../../agent-types.js';
import { mapMessageEvent } from '../message-event-mapper.js';
import { mapResultEvent } from '../result-event-mapper.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../../../../session/fleet/session-limit-store.js';
import { setAccountUsageStore } from '../../../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../../../core/usage/account-usage-store.js';

vi.mock('../../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NOTICE = "You've hit your weekly limit · resets Sep 28 at 8pm";
const RESET_EPOCH = 1_790_000_000;
const RESET_ISO = new Date(RESET_EPOCH * 1000).toISOString();

let limits: SessionLimitStore;
let usageAtPath: ReturnType<typeof vi.fn>;
let record: ReturnType<typeof vi.fn>;

function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: 0,
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    launchedAccountRoot: '/accounts/work',
  };
}

const toolState = {
  toolNameById: new Map(),
  resolvedResultIds: new Set(),
  toolInputReceived: new Set(),
} as unknown as ToolState;

function rateLimitError(text: string = NOTICE): SDKMessage {
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage;
}

function rateLimitEvent(info: Record<string, unknown>): SDKMessage {
  return { type: 'rate_limit_event', rate_limit_info: info } as unknown as SDKMessage;
}

async function drainMessage(message: SDKMessage, session: AgentSession): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of mapMessageEvent(message, session, toolState, 's-1')) out.push(e);
  return out;
}

async function drainResult(message: SDKMessage, session: AgentSession): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of mapResultEvent(message, session, 's-1')) out.push(e);
  return out;
}

function limitsOf(events: StreamEvent[]) {
  return events
    .filter((e) => e.type === 'session_status')
    .map((e) => (e.data as { limit?: unknown }).limit)
    .filter((limit) => limit !== undefined);
}

function usage(partial: Partial<AccountUsage>): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: 'work',
    path: '/accounts/work',
    label: 'Work',
    color: '#000',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [],
    state: 'ok',
    limit: null,
    updatedAt: null,
    ...partial,
  };
}

beforeEach(() => {
  limits = new SessionLimitStore(createTestDb());
  setSessionLimitStore(limits);
  usageAtPath = vi.fn(() => usage({}));
  record = vi.fn();
  setAccountUsageStore({ usageAtPath, record } as unknown as AccountUsageStore);
});

afterEach(() => {
  setSessionLimitStore(undefined);
  setAccountUsageStore(undefined);
});

describe('the rate_limit assistant error', () => {
  it('yields an uncategorised error frame carrying the CLI’s own words', async () => {
    const events = await drainMessage(rateLimitError(), makeSession());
    const errors = events.filter((e) => e.type === 'error').map((e) => e.data);
    expect(errors).toEqual([{ message: NOTICE, code: 'rate_limit' }]);
  });

  it('sets the session limit once per turn, from the store’s rejected window', async () => {
    usageAtPath.mockReturnValue(
      usage({ limit: { window: 'seven_day', resetsAt: RESET_ISO }, state: 'limited' })
    );
    const session = makeSession();
    const first = await drainMessage(rateLimitError(), session);
    const second = await drainMessage(rateLimitError(), session);

    expect(limitsOf(first)).toEqual([
      expect.objectContaining({
        accountId: 'work',
        window: 'seven_day',
        resetsAt: RESET_ISO,
        plan: { mode: 'ask' },
      }),
    ]);
    expect(limitsOf(second)).toEqual([]);
    expect(usageAtPath).toHaveBeenCalledWith('claude-code', '/accounts/work');
    // Keyed by the canonical id, with the folder the session ran in.
    expect(limits.get('sdk-1')).toMatchObject({
      accountPath: '/accounts/work',
      scope: 'account',
      state: 'limited',
      limit: { window: 'seven_day', resetsAt: RESET_ISO },
    });
  });

  it('records the known window as rejected when only the error arrived', async () => {
    usageAtPath.mockReturnValue(
      usage({ limit: { window: 'five_hour', resetsAt: RESET_ISO }, state: 'limited' })
    );
    await drainMessage(rateLimitError(), makeSession());
    expect(record).toHaveBeenCalledWith(
      'claude-code',
      { path: '/accounts/work' },
      [
        expect.objectContaining({
          key: 'five_hour',
          usedPct: null,
          status: 'rejected',
          resetsAt: RESET_ISO,
          source: 'sdk_event',
        }),
      ],
      undefined
    );
  });

  it('says unknown, records nothing, and names no account when nothing is known', async () => {
    usageAtPath.mockReturnValue(null);
    const events = await drainMessage(rateLimitError(), makeSession());
    expect(limitsOf(events)).toEqual([
      expect.objectContaining({ accountId: null, window: 'unknown', resetsAt: null }),
    ]);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('a rejected rate_limit_event', () => {
  it('sets the limit with the event’s window and reset time', async () => {
    const events = await drainResult(
      rateLimitEvent({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: RESET_EPOCH }),
      makeSession()
    );
    expect(limitsOf(events)).toEqual([
      expect.objectContaining({ accountId: 'work', window: 'seven_day', resetsAt: RESET_ISO }),
    ]);
  });

  it('sets no limit while extra usage carries the turn on', async () => {
    const session = makeSession();
    const overage = await drainResult(
      rateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true }),
      session
    );
    const inUse = await drainResult(
      rateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour', overageInUse: true }),
      session
    );
    expect(limitsOf([...overage, ...inUse])).toEqual([]);
    expect(limits.get('sdk-1')).toBeUndefined();
  });

  it('names the window for a rate_limit error that follows it in the same turn', async () => {
    const session = makeSession();
    await drainResult(
      rateLimitEvent({
        status: 'rejected',
        rateLimitType: 'seven_day_opus',
        resetsAt: RESET_EPOCH,
        isUsingOverage: true,
      }),
      session
    );
    const events = await drainMessage(rateLimitError(), session);
    expect(limitsOf(events)).toEqual([
      expect.objectContaining({ window: 'seven_day_opus', resetsAt: RESET_ISO }),
    ]);
    expect(limits.get('sdk-1')?.scope).toBe('model');
  });

  it('reports again in the next turn once the result closed this one', async () => {
    const session = makeSession();
    await drainResult(rateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour' }), session);
    await drainResult(
      { type: 'result', subtype: 'success', is_error: true } as unknown as SDKMessage,
      session
    );
    const next = await drainResult(
      rateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour' }),
      session
    );
    expect(limitsOf(next)).toHaveLength(1);
  });
});
