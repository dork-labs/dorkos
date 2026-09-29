import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, type Db } from '@dorkos/db';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { AccountUsage, LedgerObservation } from '@dorkos/shared/account-usage';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** A `status_change` as a projector ingests it (no `seq` yet). */
type StatusChange = Omit<Extract<SessionEvent, { type: 'status_change' }>, 'seq'>;
import { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import { readConfigFile } from '../../../core/usage/account-usage-reconcile.js';
import { defaultAccountFolder } from '../../../core/usage/runtime-accounts.js';
import { ledgerDir, writeLedger } from '../../../core/usage/ledger-file.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  disposeProjector,
  getOrCreateProjector,
  setSessionEventStore,
  type RawSessionEvent,
} from '../../session-state-projector.js';
import { SessionEventStore } from '../../session-event-store.js';
import { feedProjector } from '../../session-event-normalizer.js';
import { SessionContextStore } from '../session-context-store.js';
import {
  envBillsPerToken,
  predictLaunchBillsPerToken,
} from '../../../runtimes/claude-code/messaging/per-token-billing.js';
import {
  installSessionStatusHydration,
  type SessionStatusHydration,
} from '../session-status-hydration.js';

let root: string;
let dorkHome: string;
let home: string;
let db: Db;
let store: AccountUsageStore;
let registry: RuntimeRegistry;
let contextStore: SessionContextStore;
let hydration: SessionStatusHydration;
let broadcasts: AccountUsage[];
/** The folder each Claude session was launched on (what `getSessionAccount` answers). */
let launched: Map<string, string>;
type ContextReader = Mock<
  (id: string, cwd?: string) => Promise<{ contextTokens: number; contextMaxTokens: number } | null>
>;
let claude: FakeAgentRuntime & {
  readContextUsage: ContextReader;
  sessionBillsPerToken: Mock<(id: string) => Promise<boolean>>;
};
let codex: FakeAgentRuntime & { readContextUsage: ContextReader };
const opened: string[] = [];

const work = () => path.join(home, '.claude3');

/**
 * Readings a millisecond apart and strictly increasing: the ledger keeps the
 * NEWER of two readings of one window, so two taken in the same millisecond
 * would leave the second one unrecorded.
 */
let lastObservedMs = 0;
function obs(key: string, usedPct: number): LedgerObservation {
  lastObservedMs = Math.max(Date.now(), lastObservedMs + 1);
  return {
    key,
    usedPct,
    observedAt: new Date(lastObservedMs).toISOString(),
    source: 'sdk_event',
  };
}

/** Open a session the way a subscribe or snapshot does, and read its snapshot status. */
async function open(sessionId: string, persist?: 'history') {
  opened.push(sessionId);
  const projector = getOrCreateProjector(sessionId, root, persist ? { persist } : undefined);
  return (await projector.buildSnapshot(async () => [])).status;
}

async function bind(sessionId: string, runtime: string): Promise<void> {
  db.insert(sessionMetadata)
    .values({ sessionId, runtime, createdAt: new Date().toISOString() })
    .run();
}

/**
 * Wait until an `account_usage` broadcast carries this reading. Waiting on the
 * VALUE rather than a count, because an earlier reading's throttled broadcast
 * may land first and satisfy any count.
 */
async function settleTo(windowKey: string, usedPct: number): Promise<void> {
  const carries = (u: AccountUsage): boolean =>
    u.windows.some(({ key: k, usedPct: pct }) => k === windowKey && pct === usedPct);
  await vi.waitFor(() => expect(broadcasts.some(carries)).toBe(true));
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'status-hydration-')));
  dorkHome = path.join(root, 'dork');
  home = path.join(root, 'home');
  await fs.mkdir(dorkHome, { recursive: true });
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.mkdir(work(), { recursive: true });
  await fs.writeFile(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({
      runtimes: { claudeCode: { accounts: [{ id: 'work', path: work(), label: 'Work' }] } },
    })
  );
  broadcasts = [];
  store = new AccountUsageStore({
    dorkHome,
    readConfig: () => readConfigFile(path.join(dorkHome, 'config.json')),
    resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, home),
    broadcast: (usage) => broadcasts.push(usage),
    timings: { broadcastThrottleMs: 5, flushDebounceMs: 5, scanIntervalMs: 3_600_000 },
  });
  await store.load();

  db = createTestDb();
  registry = new RuntimeRegistry();
  registry.setDb(db);
  launched = new Map();
  claude = Object.assign(new FakeAgentRuntime('claude-code'), {
    getSessionAccount: (id: string) => launched.get(id),
    // The launch ladder's answer for a session that has not launched: the default.
    accountRootForSession: vi.fn(async () => path.join(home, '.claude')),
    // On a subscription unless a test says the session pays per token.
    sessionBillsPerToken: vi.fn(async () => false),
    readContextUsage: vi.fn(async () => ({
      contextTokens: 42_000,
      contextMaxTokens: 0,
    })) as ContextReader,
  });
  codex = Object.assign(new FakeAgentRuntime('codex'), {
    readContextUsage: vi.fn(async () => ({
      contextTokens: 9_000,
      contextMaxTokens: 258_400,
    })) as ContextReader,
  });
  registry.register(claude as unknown as AgentRuntime);
  registry.register(codex as unknown as AgentRuntime);
  contextStore = new SessionContextStore(db);

  hydration = installSessionStatusHydration({
    usageStore: () => store,
    contextStore,
    resolveRuntime: (id) => registry.resolveForSession(id),
    resolveCwd: async () => root,
  });
});

afterEach(async () => {
  hydration.dispose();
  setSessionEventStore(undefined);
  for (const id of opened.splice(0)) disposeProjector(id);
  store.stop();
  await store.flush();
  await fs.rm(root, { recursive: true, force: true });
});

describe('account usage on open (spec claude-account-fleet §6 U)', () => {
  it("a Claude session on a registered account opens with that account's cached usage, and its usage reads from it", async () => {
    store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 40)]);
    launched.set('s-work', work());
    const status = await open('s-work');
    expect(status.accountUsage).toMatchObject({ runtime: 'claude-code', accountId: 'work' });
    expect(status.accountUsage!.windows.map((w) => [w.key, w.usedPct])).toEqual([
      ['five_hour', 40],
    ]);
    // No turn of its own, and the status already shows the account's binding window.
    expect(status.usage).toMatchObject({ kind: 'subscription', utilization: 0.4 });
  });

  it('a Claude session billed per token keeps its own pay-as-you-go usage on a subscription folder', async () => {
    store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 40)]);
    launched.set('s-key', work());
    claude.sessionBillsPerToken.mockResolvedValue(true);
    const projector = getOrCreateProjector('s-key', root);
    opened.push('s-key');
    const payAsYouGo: StatusChange = {
      type: 'status_change',
      status: { usage: { kind: 'pay-as-you-go', costUsd: 0.4 } },
    };
    projector.ingest(payAsYouGo as RawSessionEvent);
    const status = (await projector.buildSnapshot(async () => [])).status;
    // It still names its account, and its bar is still its own cost.
    expect(status.accountUsage?.accountId).toBe('work');
    expect(status.usage).toEqual({ kind: 'pay-as-you-go', costUsd: 0.4 });

    store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 60)]);
    await settleTo('five_hour', 60);
    expect(projector.getStatus().usage).toEqual({ kind: 'pay-as-you-go', costUsd: 0.4 });
  });

  it("a key inherited from the server's environment reads as per token on open and after a store change", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited');
    // The runtime's real prediction: what a launch made now would receive.
    // No key reference and no credits here, so the inherited key is the only signal.
    claude.sessionBillsPerToken.mockImplementation(async () =>
      predictLaunchBillsPerToken({
        keyReferenceConfigured: false,
        creditsOn: false,
        // eslint-disable-next-line no-restricted-syntax -- the parent environment is the input under test
        inheritedKey: envBillsPerToken(process.env),
      })
    );
    try {
      store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 40)]);
      launched.set('s-inherit', work());
      const opened1 = await open('s-inherit');
      expect(opened1.accountUsage?.accountId).toBe('work');
      expect(opened1.usage).toBeNull();

      store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 60)]);
      await settleTo('five_hour', 60);
      const after = await open('s-inherit');
      expect(after.accountUsage!.windows[0]).toMatchObject({ usedPct: 60 });
      expect(after.usage).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a single-account Claude session opens with the implicit default', async () => {
    store.record('claude-code', { path: path.join(home, '.claude') }, [obs('seven_day', 12)]);
    const status = await open('s-default');
    expect(status.accountUsage).toMatchObject({ runtime: 'claude-code', accountId: 'default' });
    expect(status.accountUsage!.windows[0]).toMatchObject({ key: 'seven_day', usedPct: 12 });
  });

  it('a Codex session opens with the Codex default', async () => {
    await bind('s-codex', 'codex');
    store.record('codex', { accountId: 'default' }, [obs('five_hour', 7)]);
    const status = await open('s-codex');
    expect(status.accountUsage).toMatchObject({ runtime: 'codex', accountId: 'default' });
    expect(status.accountUsage!.windows[0]).toMatchObject({ key: 'five_hour', usedPct: 7 });
  });

  it('a session on an unregistered folder opens with its memory-only record, matched by path', async () => {
    const stray = path.join(home, '.claude9');
    await fs.mkdir(stray);
    store.record('claude-code', { path: stray }, [obs('five_hour', 3)]);
    launched.set('s-stray', stray);
    const status = await open('s-stray');
    expect(status.accountUsage).toMatchObject({ accountId: null, path: stray });
    expect(status.accountUsage!.windows[0]).toMatchObject({ usedPct: 3 });
  });

  it("one reading sends one account_usage event and both sessions on the account carry it; another account's session is unaffected", async () => {
    launched.set('s-a', work());
    launched.set('s-b', work());
    await open('s-a');
    await open('s-b');
    const other = await open('s-other');
    expect(other.accountUsage?.accountId).toBe('default');

    store.record('claude-code', { path: work() }, [obs('five_hour', 66)]);
    await settleTo('five_hour', 66);
    expect(broadcasts.filter((u) => u.accountId === 'work')).toHaveLength(1);

    for (const id of ['s-a', 's-b']) {
      const status = await open(id);
      expect(status.accountUsage!.windows.map((w) => w.usedPct)).toEqual([66]);
      expect(status.usage).toMatchObject({ utilization: 0.66 });
    }
    const after = await open('s-other');
    expect(after.accountUsage).toEqual(other.accountUsage);
  });

  it('a ledger another program wrote reaches live sessions the same way', async () => {
    launched.set('s-cli', work());
    await open('s-cli');
    await writeLedger(
      ledgerDir(dorkHome, 'claude-code'),
      'work',
      [obs('seven_day', 81)],
      new Date()
    );
    await store.scan();
    await settleTo('seven_day', 81);
    const status = await open('s-cli');
    expect(status.accountUsage!.windows).toEqual([
      expect.objectContaining({ key: 'seven_day', usedPct: 81 }),
    ]);
  });

  it('an idle log-backed session writes no event rows for usage changes', async () => {
    const events = new SessionEventStore(db);
    setSessionEventStore(events);
    await bind('s-idle', 'codex');
    await open('s-idle', 'history');
    const before = events.readAll('s-idle').length;
    store.record('codex', { accountId: 'default' }, [obs('five_hour', 50)]);
    await settleTo('five_hour', 50);
    store.record('codex', { accountId: 'default' }, [obs('five_hour', 51)]);
    await settleTo('five_hour', 51);
    const status = await open('s-idle', 'history');
    expect(status.accountUsage!.windows[0]).toMatchObject({ usedPct: 51 });
    expect(events.readAll('s-idle')).toHaveLength(before);
    expect(before).toBe(0);
  });

  it('the first send re-stamps the session with the account its launch settled on', async () => {
    store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 20)]);
    await settleTo('five_hour', 20);
    const first = await open('s-hint');
    expect(first.accountUsage?.accountId).toBe('default');
    // The per-send hint named `work`; the launch settles on its folder.
    hydration.noteAccountLaunched('s-hint', work(), false);
    const next = await open('s-hint');
    expect(next.accountUsage?.accountId).toBe('work');
    // And later readings for `work` now reach it.
    store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 21)]);
    await settleTo('five_hour', 21);
    expect((await open('s-hint')).accountUsage!.windows[0]).toMatchObject({ usedPct: 21 });
  });

  it('a session opened before it was bound is re-resolved when its first turn ends', async () => {
    store.record('codex', { accountId: 'default' }, [obs('five_hour', 44)]);
    // No binding row yet: the registry infers Claude Code.
    const projector = getOrCreateProjector('s-late', root);
    opened.push('s-late');
    expect((await projector.buildSnapshot(async () => [])).status.accountUsage?.runtime).toBe(
      'claude-code'
    );
    await bind('s-late', 'codex');
    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'done', data: { sessionId: 's-late' } };
    }
    await feedProjector(projector, turn());
    await vi.waitFor(() => expect(projector.getStatus().accountUsage?.runtime).toBe('codex'));
    expect(projector.getStatus().accountUsage!.windows[0]).toMatchObject({ usedPct: 44 });
  });

  it('opening a session never creates a session_metadata row', async () => {
    await open('s-new');
    expect(db.select().from(sessionMetadata).all()).toEqual([]);
  });
});

describe('context usage per session (spec claude-account-fleet §6 U)', () => {
  async function* turn(contextTokens: number): AsyncIterable<StreamEvent> {
    yield {
      type: 'session_status',
      data: { sessionId: 'x', contextTokens, contextMaxTokens: 200_000 },
    };
    yield { type: 'done', data: { sessionId: 'x' } };
  }

  it('after a turn the row holds the figures, and a projector after a restart shows them with no transcript read', async () => {
    const projector = getOrCreateProjector('s-ctx', root);
    opened.push('s-ctx');
    await projector.buildSnapshot(async () => []);
    claude.readContextUsage = vi.fn(async () => null) as ContextReader;
    await feedProjector(projector, turn(120_000));
    expect(contextStore.get('s-ctx')).toMatchObject({
      contextTokens: 120_000,
      contextMaxTokens: 200_000,
    });

    // A restart: the projector is gone, the row is not.
    disposeProjector('s-ctx');
    const reader = vi.fn(async () => ({ contextTokens: 1, contextMaxTokens: 1 })) as ContextReader;
    claude.readContextUsage = reader;
    const status = await open('s-ctx');
    expect(status.contextUsage).toMatchObject({
      totalTokens: 120_000,
      maxTokens: 200_000,
      observedAt: contextStore.get('s-ctx')!.observedAt,
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it('a derived reading never replaces one a turn wrote while it was being read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    claude.readContextUsage = vi.fn(async () => {
      await gate;
      return { contextTokens: 5_000, contextMaxTokens: 0 };
    }) as ContextReader;
    const projector = getOrCreateProjector('s-race', root);
    opened.push('s-race');
    const snapshot = projector.buildSnapshot(async () => []);
    await vi.waitFor(() => expect(claude.readContextUsage).toHaveBeenCalled());
    // The turn ends (and writes its reading) while the derivation is in flight.
    await feedProjector(projector, turn(150_000));
    expect(contextStore.get('s-race')?.contextTokens).toBe(150_000);
    release();
    await snapshot;

    expect(contextStore.get('s-race')?.contextTokens).toBe(150_000);
    expect(projector.getStatus().contextUsage?.totalTokens).toBe(150_000);
  });

  it('a hydrate that lands after a live reading leaves the live reading in place', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    claude.readContextUsage = vi.fn(async () => {
      await gate;
      return { contextTokens: 5_000, contextMaxTokens: 0 };
    }) as ContextReader;
    const projector = getOrCreateProjector('s-late-ctx', root);
    opened.push('s-late-ctx');
    await vi.waitFor(() => expect(claude.readContextUsage).toHaveBeenCalled());
    // A live reading arrives mid-turn (no turn end, so nothing is stored yet).
    const live: StatusChange = {
      type: 'status_change',
      status: { contextUsage: { totalTokens: 80_000, maxTokens: 200_000 } },
    };
    projector.ingest(live as RawSessionEvent);
    release();
    await projector.buildSnapshot(async () => []);
    expect(projector.getStatus().contextUsage?.totalTokens).toBe(80_000);
  });

  it("with no row, the reading is derived once from the runtime's own record and stored", async () => {
    const status = await open('s-derive');
    expect(status.contextUsage).toMatchObject({ totalTokens: 42_000, maxTokens: 0 });
    expect(status.contextUsage!.observedAt).toEqual(expect.any(String));
    expect(contextStore.get('s-derive')).toMatchObject({ contextTokens: 42_000 });
    expect(claude.readContextUsage).toHaveBeenCalledTimes(1);

    disposeProjector('s-derive');
    await open('s-derive');
    expect(claude.readContextUsage).toHaveBeenCalledTimes(1);
  });

  it('a Codex session derives its reading from the rollout through its runtime', async () => {
    await bind('s-codex-ctx', 'codex');
    const status = await open('s-codex-ctx');
    expect(status.contextUsage).toMatchObject({ totalTokens: 9_000, maxTokens: 258_400 });
  });

  it('a runtime with no record of its own (OpenCode) reports none until its first turn', async () => {
    const opencode = new FakeAgentRuntime('opencode');
    registry.register(opencode);
    await bind('s-oc', 'opencode');
    const status = await open('s-oc');
    expect(status.contextUsage).toBeNull();
    expect(contextStore.get('s-oc')).toBeNull();
  });
});
