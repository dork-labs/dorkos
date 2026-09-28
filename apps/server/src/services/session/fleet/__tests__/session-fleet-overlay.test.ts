/**
 * The fleet fields on a session list page (spec `claude-account-fleet` D7),
 * over a REAL account usage store: the account rules (registered, the machine's
 * own folder, an alias, an unregistered folder) are the store's, so a fake
 * store would only restate what this test is meant to check.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionLimit } from '@dorkos/shared/schemas';
import type { Session } from '@dorkos/shared/types';
import { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import { defaultAccountFolder } from '../../../core/usage/runtime-accounts.js';
import {
  applySessionFleetOverlay,
  type SessionFleetOverlayDeps,
} from '../session-fleet-overlay.js';

let root: string;
let home: string;
let config: unknown;
let store: AccountUsageStore;
let realpathCalls: string[];

const claudeHome = () => path.join(home, '.claude');
const claude3 = () => path.join(home, '.claude3');

function session(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: overrides.id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

const LIMIT: SessionLimit = {
  accountId: 'claude3',
  window: 'five_hour',
  resetsAt: '2026-09-27T18:00:00.000Z',
  since: '2026-09-27T13:00:00.000Z',
  plan: { mode: 'ask' },
  scope: 'account',
  state: 'limited',
};

async function loadStore(): Promise<void> {
  store = new AccountUsageStore({
    dorkHome: path.join(root, 'dork'),
    readConfig: async () => config,
    resolveDefaultRoot: (runtime, cfg) => defaultAccountFolder(runtime, cfg, home),
    // Folders compare as written: no disk, and every lookup is counted.
    realpath: (dir) => {
      realpathCalls.push(dir);
      return dir;
    },
    timings: { scanIntervalMs: 3_600_000 },
  });
  await store.load();
  realpathCalls = [];
}

function deps(overrides: Partial<SessionFleetOverlayDeps> = {}): SessionFleetOverlayDeps {
  return {
    store,
    projectorFor: () => undefined,
    sessionAccountOf: () => undefined,
    limitsFor: () => new Map(),
    applyTrackerItems: async () => {},
    ...overrides,
  };
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-overlay-')));
  home = path.join(root, 'home');
  realpathCalls = [];
  config = {
    runtimes: {
      claudeCode: {
        defaultAccount: null,
        accounts: [{ id: 'claude3', path: claude3(), label: 'Claude3' }],
      },
    },
  };
  await loadStore();
});

afterEach(async () => {
  store.stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe('applySessionFleetOverlay: accountId', () => {
  it('names the registered account, the machine default, and `default` for Codex and OpenCode', async () => {
    const page = [
      session({ id: 'registered', account: claude3() }),
      session({ id: 'ambient', account: claudeHome() }),
      session({ id: 'codex', runtime: 'codex' }),
      session({ id: 'opencode', runtime: 'opencode' }),
    ];
    const usage = await applySessionFleetOverlay(page, deps());

    expect(page.map((s) => s.accountId)).toEqual(['claude3', 'default', 'default', 'default']);
    expect(usage?.map((u) => [u.runtime, u.accountId])).toEqual([
      ['claude-code', 'claude3'],
      ['claude-code', 'default'],
      ['codex', 'default'],
      ['opencode', 'default'],
    ]);
  });

  it("gives the machine's own folder the id of the row `default` aliases", async () => {
    config = {
      runtimes: {
        claudeCode: {
          defaultAccount: null,
          accounts: [{ id: 'main', path: claudeHome(), label: 'Main' }],
        },
      },
    };
    store.stop();
    await loadStore();
    const page = [session({ id: 'ambient', account: claudeHome() })];
    const usage = await applySessionFleetOverlay(page, deps());

    expect(page[0]!.accountId).toBe('main');
    expect(usage?.map((u) => u.accountId)).toEqual(['main']);
  });

  it('leaves an unregistered folder, a session with no account and an unknown runtime without one, and reports no usage', async () => {
    const page = [
      session({ id: 'unregistered', account: path.join(home, '.claude9') }),
      session({ id: 'no-account' }),
      session({ id: 'fake', runtime: 'test-mode', account: claude3() }),
    ];
    const usage = await applySessionFleetOverlay(page, deps());

    expect(page.map((s) => s.accountId)).toEqual([undefined, undefined, undefined]);
    expect(usage).toBeUndefined();
  });

  it('reads usage from memory once for the page: one peek, no list, one folder lookup per distinct folder', async () => {
    const peek = vi.spyOn(store, 'peek');
    const list = vi.spyOn(store, 'list');
    const page = [
      session({ id: 'a', account: claude3() }),
      session({ id: 'b', account: claude3() }),
      session({ id: 'c', account: claude3() }),
      session({ id: 'd', account: claudeHome() }),
    ];
    await applySessionFleetOverlay(page, deps());

    expect(peek).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledWith('claude-code', ['claude3', 'default']);
    expect(list).not.toHaveBeenCalled();
    // Two distinct folders on four sessions: the lookups follow the folders.
    expect(new Set(realpathCalls)).toEqual(new Set([claude3(), claudeHome()]));
    expect(realpathCalls.filter((dir) => dir === claude3()).length).toBeLessThanOrEqual(2);
  });

  it("names a new session with no transcript yet from the runtime's in-memory account, preferring it to the transcript's", async () => {
    const page = [
      session({ id: 'new' }),
      session({ id: 'moved', account: path.join(home, '.claude9') }),
    ];
    const usage = await applySessionFleetOverlay(
      page,
      deps({
        sessionAccountOf: (s) => (s.id === 'new' || s.id === 'moved' ? claude3() : undefined),
      })
    );

    expect(page.map((s) => s.accountId)).toEqual(['claude3', 'claude3']);
    expect(usage?.map((u) => u.accountId)).toEqual(['claude3']);
  });

  it('sets no accountId and reports no usage when no store is wired', async () => {
    const page = [session({ id: 'registered', account: claude3() })];
    const usage = await applySessionFleetOverlay(page, deps({ store: undefined }));

    expect(page[0]!.accountId).toBeUndefined();
    expect(usage).toBeUndefined();
  });
});

describe('applySessionFleetOverlay: status', () => {
  it("takes a live session's status from its projector", async () => {
    const page = [session({ id: 'live', account: claude3() })];
    await applySessionFleetOverlay(
      page,
      deps({
        projectorFor: (id) =>
          id === 'live'
            ? { getStatus: () => ({ lifecycle: 'streaming', limit: LIMIT }) }
            : undefined,
      })
    );

    expect(page[0]!.status).toEqual({ lifecycle: 'streaming', limit: LIMIT });
  });

  it('reads the stored limits of sessions with no projector in one call, and leaves the rest without a status', async () => {
    const limitsFor = vi.fn((ids: readonly string[]) => {
      void ids;
      return new Map([['limited', { limit: LIMIT }]]);
    });
    const page = [session({ id: 'live' }), session({ id: 'limited' }), session({ id: 'quiet' })];
    await applySessionFleetOverlay(
      page,
      deps({
        projectorFor: (id) =>
          id === 'live' ? { getStatus: () => ({ lifecycle: 'idle', limit: null }) } : undefined,
        limitsFor,
      })
    );

    expect(limitsFor).toHaveBeenCalledTimes(1);
    expect(limitsFor).toHaveBeenCalledWith(['limited', 'quiet']);
    expect(page.map((s) => s.status)).toEqual([
      { lifecycle: 'idle', limit: null },
      { lifecycle: 'idle', limit: LIMIT },
      undefined,
    ]);
  });

  it('merges onto a status another overlay already set, from a projector or a stored limit', async () => {
    const extra = { accountUsage: { accountId: 'claude3' } };
    const page = [
      session({
        id: 'live',
        status: { lifecycle: 'idle', limit: null, ...extra } as Session['status'],
      }),
      session({
        id: 'limited',
        status: { lifecycle: 'idle', limit: null, ...extra } as Session['status'],
      }),
    ];
    await applySessionFleetOverlay(
      page,
      deps({
        projectorFor: (id) =>
          id === 'live'
            ? { getStatus: () => ({ lifecycle: 'streaming', limit: null }) }
            : undefined,
        limitsFor: () => new Map([['limited', { limit: LIMIT }]]),
      })
    );

    expect(page[0]!.status).toEqual({ lifecycle: 'streaming', limit: null, ...extra });
    expect(page[1]!.status).toEqual({ lifecycle: 'idle', limit: LIMIT, ...extra });
  });

  it('asks for no stored limits when every session is live', async () => {
    const limitsFor = vi.fn(() => new Map());
    await applySessionFleetOverlay(
      [session({ id: 'live' })],
      deps({
        projectorFor: () => ({ getStatus: () => ({ lifecycle: 'idle', limit: null }) }),
        limitsFor,
      })
    );
    expect(limitsFor).not.toHaveBeenCalled();
  });
});

describe('applySessionFleetOverlay: trackerItem', () => {
  it('lets the flow link set the work item on the page', async () => {
    const page = [session({ id: 'flow-run', cwd: '/repo' })];
    await applySessionFleetOverlay(
      page,
      deps({
        applyTrackerItems: async (p) => {
          p[0]!.trackerItem = { id: 'DOR-1', stage: 'execute', runStatus: 'running' };
        },
      })
    );
    expect(page[0]!.trackerItem).toEqual({ id: 'DOR-1', stage: 'execute', runStatus: 'running' });
  });

  it('still returns the page when the flow file cannot be read', async () => {
    const page = [session({ id: 'registered', account: claude3() })];
    const usage = await applySessionFleetOverlay(
      page,
      deps({
        applyTrackerItems: async () => {
          throw new Error('boom');
        },
      })
    );
    expect(page[0]!.accountId).toBe('claude3');
    expect(page[0]!.trackerItem).toBeUndefined();
    expect(usage?.map((u) => u.accountId)).toEqual(['claude3']);
  });
});
