/**
 * OpenCode's per-turn cost reaches the usage store as the `default` account's
 * monthly spend, and a provider rate-limit or credit error becomes a
 * window-less ledger entry and the session's `limit` (spec
 * `claude-account-fleet` §6 R, D4). Driven through the real event mapper and a
 * real usage store on a temporary data folder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Event } from '@opencode-ai/sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import { readConfigFile } from '../../../core/usage/account-usage-reconcile.js';
import { ledgerDir, readLedger } from '../../../core/usage/ledger-file.js';
import { defaultAccountFolder } from '../../../core/usage/runtime-accounts.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../../session/fleet/session-limit-store.js';
import { createOpenCodeEventContext, mapOpenCodeEvent } from '../events/event-mapper.js';
import { openCodeLimitSignal, utcMonthStart } from '../events/account-usage.js';
import {
  OC_SESSION_A,
  assistantMessage,
  messageUpdated,
  sessionError,
  unknownError,
} from './opencode-sse-fixtures.js';

type SessionErrorPayload = NonNullable<
  Extract<Event, { type: 'session.error' }>['properties']['error']
>;

const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';
const OC = OC_SESSION_A;

let root: string;
let dorkHome: string;
let clock: number;
let stores: AccountUsageStore[];
let limits: SessionLimitStore;

async function makeStore(): Promise<AccountUsageStore> {
  const store = new AccountUsageStore({
    dorkHome,
    readConfig: () => readConfigFile(path.join(dorkHome, 'config.json')),
    resolveDefaultRoot: (runtime, config) =>
      defaultAccountFolder(runtime, config, path.join(root, 'home')),
    now: () => new Date(clock),
    lockOptions: { giveUpMs: 200 },
    timings: { scanIntervalMs: 3_600_000, broadcastThrottleMs: 0 },
  });
  stores.push(store);
  await store.load();
  setAccountUsageStore(store);
  return store;
}

/** One turn that completes one assistant message costing `cost`, at the store's clock. */
function turnCosting(messageId: string, cost: number): void {
  const ctx = createOpenCodeEventContext(SESSION_ID, () => clock);
  const message = assistantMessage(OC, { id: messageId, completed: true, cost });
  message.time.completed = clock;
  mapOpenCodeEvent(messageUpdated(message), ctx);
}

function spendOf(store: AccountUsageStore) {
  return store.peek('opencode', ['default'])[0]?.spend ?? null;
}

function apiError(statusCode: number, message: string, headers?: Record<string, string>) {
  return {
    name: 'APIError' as const,
    data: {
      message,
      statusCode,
      isRetryable: false,
      ...(headers ? { responseHeaders: headers } : {}),
    },
  } satisfies SessionErrorPayload;
}

/** A turn on `providerID` that fails with `error`; returns what it emitted. */
function failingTurn(error: SessionErrorPayload): StreamEvent[] {
  const ctx = createOpenCodeEventContext(SESSION_ID, () => clock);
  const message = assistantMessage(OC, { id: 'msg_fail', completed: false });
  message.providerID = 'openrouter';
  mapOpenCodeEvent(messageUpdated(message), ctx);
  return mapOpenCodeEvent(sessionError(OC, error), ctx);
}

function limitOf(events: StreamEvent[]) {
  const status = events.find((e) => e.type === 'session_status' && 'limit' in e.data);
  return status ? (status.data as { limit: unknown }).limit : undefined;
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-usage-')));
  dorkHome = path.join(root, 'dork');
  await fs.mkdir(dorkHome, { recursive: true });
  clock = Date.parse('2026-09-27T12:00:00.000Z');
  stores = [];
  limits = new SessionLimitStore(createTestDb());
  setSessionLimitStore(limits);
});

afterEach(async () => {
  setAccountUsageStore(undefined);
  setSessionLimitStore(undefined);
  for (const store of stores) {
    store.stop();
    await store.flush();
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe('OpenCode spend', () => {
  it('two turns accumulate spend for the current UTC month, with no cap', async () => {
    const store = await makeStore();
    turnCosting('msg_a', 0.25);
    clock += 60_000;
    turnCosting('msg_b', 0.5);

    expect(spendOf(store)).toMatchObject({
      periodStart: '2026-09-01T00:00:00.000Z',
      costUsd: 0.75,
      limitUsd: null,
      source: 'sidecar',
    });
    // Written to the shared ledger (never directly: through the store's flush).
    await store.flush();
    const ledger = await readLedger(ledgerDir(dorkHome, 'opencode'), 'default');
    expect(ledger?.spend).toMatchObject({ costUsd: 0.75, source: 'sidecar' });
  });

  it('counts a message the sidecar announces again only once', async () => {
    const store = await makeStore();
    const ctx = createOpenCodeEventContext(SESSION_ID, () => clock);
    const message = assistantMessage(OC, { id: 'msg_a', completed: true, cost: 0.25 });
    message.time.completed = clock;
    mapOpenCodeEvent(messageUpdated(message), ctx);
    mapOpenCodeEvent(messageUpdated(message), ctx);
    expect(spendOf(store)?.costUsd).toBe(0.25);
  });

  it('a completed message re-announced later adds nothing', async () => {
    const store = await makeStore();
    const ctx = createOpenCodeEventContext(SESSION_ID, () => clock);
    const message = assistantMessage(OC, { id: 'msg_a', completed: true, cost: 0.25 });
    message.time.completed = clock;
    mapOpenCodeEvent(messageUpdated(message), ctx);
    clock += 5_000;
    mapOpenCodeEvent(messageUpdated(message), ctx);
    expect(spendOf(store)?.costUsd).toBe(0.25);
  });

  it('a message whose cost grew adds only the difference', async () => {
    const store = await makeStore();
    const ctx = createOpenCodeEventContext(SESSION_ID, () => clock);
    const message = assistantMessage(OC, { id: 'msg_a', completed: true, cost: 0.25 });
    message.time.completed = clock;
    mapOpenCodeEvent(messageUpdated(message), ctx);
    clock += 5_000;
    mapOpenCodeEvent(messageUpdated({ ...message, cost: 0.4 }), ctx);
    expect(spendOf(store)?.costUsd).toBeCloseTo(0.4, 10);
  });

  it('two messages in the same millisecond both count', async () => {
    const store = await makeStore();
    const ctx = createOpenCodeEventContext(SESSION_ID, () => clock);
    for (const [id, cost] of [
      ['msg_a', 0.1],
      ['msg_b', 0.2],
    ] as const) {
      const message = assistantMessage(OC, { id, completed: true, cost });
      message.time.completed = clock;
      mapOpenCodeEvent(messageUpdated(message), ctx);
    }
    expect(spendOf(store)?.costUsd).toBeCloseTo(0.3, 10);
  });

  it('never counts a message that completed before the turn began', async () => {
    const store = await makeStore();
    const ctx = createOpenCodeEventContext(SESSION_ID, () => clock);
    const message = assistantMessage(OC, { id: 'msg_old', completed: true, cost: 3 });
    message.time.completed = clock - 3_600_000;
    mapOpenCodeEvent(messageUpdated(message), ctx);
    expect(spendOf(store)).toBeNull();
  });

  it('a new month starts again from that turn’s cost', async () => {
    const store = await makeStore();
    turnCosting('msg_a', 4);
    clock = Date.parse('2026-10-01T00:00:05.000Z');
    turnCosting('msg_b', 0.5);
    expect(spendOf(store)).toMatchObject({
      periodStart: '2026-10-01T00:00:00.000Z',
      costUsd: 0.5,
    });
  });

  it('a restart does not reset the month: the total carries on from the ledger', async () => {
    const first = await makeStore();
    turnCosting('msg_a', 1.5);
    await first.flush();
    first.stop();

    clock += 60_000;
    const second = await makeStore();
    turnCosting('msg_b', 0.5);
    expect(spendOf(second)?.costUsd).toBe(2);
  });

  it('utcMonthStart is the first instant of the UTC month', () => {
    expect(utcMonthStart(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('OpenCode limits', () => {
  it('a rate-limit error records rate_limit:<provider> rejected and sets the session limit', async () => {
    const store = await makeStore();
    const events = failingTurn(
      apiError(429, 'Rate limit exceeded: free-models-per-day', { 'Retry-After': '120' })
    );

    const resetsAt = new Date(clock + 120_000).toISOString();
    expect(limitOf(events)).toEqual({
      accountId: 'default',
      window: 'unknown',
      resetsAt,
      since: new Date(clock).toISOString(),
      plan: { mode: 'ask' },
    });
    // The turn's own error still shows, and the limit comes after it.
    expect(events.map((e) => e.type)).toEqual(['error', 'session_status']);
    expect(store.peek('opencode', ['default'])[0]?.windows).toContainEqual(
      expect.objectContaining({
        key: 'rate_limit:openrouter',
        status: 'rejected',
        usedPct: null,
        resetsAt,
        source: 'error',
      })
    );
    expect(limits.get(SESSION_ID)).toMatchObject({ scope: 'account', accountPath: null });
  });

  it('a credit error records credits:<provider>', async () => {
    const store = await makeStore();
    const events = failingTurn(
      apiError(402, 'This request requires more credits, or fewer max_tokens.')
    );
    expect(limitOf(events)).toMatchObject({ window: 'unknown', resetsAt: null });
    expect(store.peek('opencode', ['default'])[0]?.windows).toContainEqual(
      expect.objectContaining({ key: 'credits:openrouter', status: 'rejected', resetsAt: null })
    );
  });

  it('an ordinary error records nothing and sets no limit', async () => {
    const store = await makeStore();
    const events = failingTurn(unknownError('tool crashed: ENOENT'));
    expect(limitOf(events)).toBeUndefined();
    expect(store.peek('opencode', ['default'])[0]?.windows ?? []).toEqual([]);
    expect(limits.get(SESSION_ID)).toBeUndefined();
  });

  it('classifies by status first, then by the providers’ own words', () => {
    expect(openCodeLimitSignal(apiError(429, 'slow down'))?.kind).toBe('rate_limit');
    // OpenAI's out-of-quota answer is a 429 that means money, not speed.
    expect(
      openCodeLimitSignal(apiError(429, 'You exceeded your current quota, check your billing'))
        ?.kind
    ).toBe('credits');
    expect(openCodeLimitSignal(unknownError('Too Many Requests'))?.kind).toBe('rate_limit');
    expect(openCodeLimitSignal(apiError(500, 'internal error'))).toBeNull();
    expect(openCodeLimitSignal(undefined)).toBeNull();
  });

  it('reads a Retry-After date as the reset time', () => {
    const at = 'Sun, 27 Sep 2026 13:00:00 GMT';
    expect(
      openCodeLimitSignal(apiError(429, 'x', { 'retry-after': at }), new Date(clock))?.resetsAt
    ).toBe(new Date(at).toISOString());
  });
});
