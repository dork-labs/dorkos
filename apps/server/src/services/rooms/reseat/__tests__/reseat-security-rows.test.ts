/**
 * Security's rows for re-seating (DOR-3143), one test each:
 *
 * - **Row 6 + hop**: a seat a stranger's words reached is moved; its next post
 *   still holds the Full autonomy agent it wakes to asking, so that agent's
 *   write raises a card. And again after a restart, when nothing is left in
 *   memory and only the stranger's message itself is known.
 * - **Power only down (Must 1)**: a seat set below Full stays there.
 * - **Accounts (Must 4)**: never DorkOS credits, never an account kept to other
 *   projects (how `claude-ab1` is kept out), never one that is out, and nothing
 *   the agent writes in its own folder changes that.
 * - **Tool + audit (Musts 5, 6)**: an agent calling `rooms.reseat` is refused as
 *   people-only, and each move writes exactly one Activity entry.
 *
 * @vitest-environment node
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CREDITS_ACCOUNT_ID, type AccountUsage } from '@dorkos/shared/account-usage';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import type { AuthorRegistry } from '../../author-registry.js';
import type { RankedAccount } from '../../../core/usage/account-ranking.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import type { RuntimeAccount } from '../../../core/usage/runtime-accounts.js';
import { RoomSeatMover, type ReseatActivity, type SeatMoverDeps } from '../seat-mover.js';

/** The stored `runtimes.claudeCode` block the account rules are read from. */
let claudeCode: Record<string, unknown> = {};

vi.mock('../../../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/config-manager.js')>()),
  configManager: {
    get: (section: string) =>
      section === 'runtimes' ? { claudeCode } : section === 'auth' ? { enabled: false } : undefined,
    set: () => {},
  },
}));

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes!;
const SEAT = { roomId: 'room-1', authorId: 'ana', agentPath: '/agents/ana', sessionId: 'old-seat' };

const AUTHORS = {
  getMany: (ids: readonly string[]) =>
    new Map(
      ids
        .map((id) => [id, RECORDS[id]] as const)
        .filter((pair): pair is readonly [string, (typeof RECORDS)[string]] => !!pair[1])
    ),
} as unknown as AuthorRegistry;
const RECORDS: Record<string, { kind: 'human' | 'agent'; naturalKey: string }> = {
  ana: { kind: 'agent', naturalKey: '/agents/ana' },
  stranger: { kind: 'human', naturalKey: 'platform:telegram:4242' },
};

/** A runtime that records each turn's options, wrapped the way the registry wraps it. */
async function seam(stored: Record<string, string>) {
  const { recordTurnLevels } = await import('../../../core/turn-power/turn-levels.js');
  const sent = new Map<string, MessageOpts | undefined>();
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(sessionId: string, _content: string, opts?: MessageOpts) {
        sent.set(sessionId, opts);
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    (id) => stored[id] ?? null
  );
  return { runtime, sent };
}

async function run(runtime: AgentRuntime, sessionId: string, opts?: MessageOpts) {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** The mode a Full autonomy conversation runs a turn at under its ceiling: `default` asks, so a write cards. */
function runsAt(opts: MessageOpts | undefined): string {
  return opts?.permissionCeiling === undefined
    ? 'bypassPermissions'
    : clampModeToCeiling(MODES, 'bypassPermissions', opts.permissionCeiling);
}

function usage(id: string, limited = false): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: id,
    path: `/accounts/${id}`,
    label: id,
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [],
    state: limited ? 'limited' : 'ok',
    limit: limited ? { window: 'five_hour', resetsAt: null } : null,
    updatedAt: null,
  };
}

function rankedRow(id: string, limited = false): RankedAccount {
  return {
    runtime: 'claude-code',
    id,
    label: id,
    color: '#123456',
    eligible: !limited,
    reason: '',
    usage: usage(id, limited),
  };
}

function mover(overrides: Partial<SeatMoverDeps> = {}) {
  const settings = new Map<string, SessionSettings>();
  const activity: ReseatActivity[] = [];
  let n = 0;
  const m = new RoomSeatMover({
    rebind: () => true,
    runtimeOf: async () => 'claude-code',
    newSeatRuntime: async () => 'claude-code',
    settingsOf: async (id) => settings.get(id) ?? null,
    saveSettings: async (id, value) => {
      settings.set(id, value);
    },
    declaredModes: () => MODES,
    effectiveModeOf: async () => undefined,
    accountOf: async () => ({ id: 'claude4', label: 'claude4', usage: usage('claude4', true) }),
    ranking: async () => [rankedRow('claude4', true), rankedRow('claude3')],
    transcriptState: async () => 'present',
    summaryOf: async () => 'SUMMARY',
    recordActivity: (entry) => activity.push(entry),
    newSessionId: () => `new-seat-${(n += 1)}`,
    ...overrides,
  });
  return { m, settings, activity };
}

const OPTS = { alreadyPosted: false, hideAccounts: false };

afterEach(async () => {
  const { resetOutsiderTurns } = await import('../../../session/origin/outsider-turns.js');
  resetOutsiderTurns();
});

// DOR-3390: the mark gates the woken agent's risky actions and shell; it no longer caps its level.
describe('row 6 + hop: a moved marked seat still marks the agent it wakes', () => {
  it('marks a Full autonomy agent, at its own level', async () => {
    const { ceilingForEntry } = await import('../../limits/turn-ceiling.js');
    const { noteEntryLevel, postLevelFor, lastTurnLevelOf } =
      await import('../../../core/turn-power/turn-levels.js');
    const { runtime, sent } = await seam({
      'old-seat': 'bypassPermissions',
      bo: 'bypassPermissions',
    });
    // A stranger's message wakes Ana's seat, then her account runs out and the seat moves.
    await run(runtime, 'old-seat', ceilingForEntry(AUTHORS, { id: 'e-1', authorId: 'stranger' }));
    const { m } = mover();
    const moved = await m.afterLimit(SEAT, 'e-1', OPTS);
    expect(moved.kind).toBe('moved');

    // The new seat posts @bo before running anything of its own.
    noteEntryLevel('post-1', postLevelFor(['new-seat-1']));
    // In the owner's own circle; outside it Bo would be held (DOR-3390, Security's M-B).
    await run(
      runtime,
      'bo',
      ceilingForEntry(AUTHORS, { id: 'post-1', authorId: 'ana' }, false, '', { ownCircle: true })
    );

    expect(runsAt(sent.get('bo'))).toBe('bypassPermissions');
    expect(lastTurnLevelOf('bo')?.outsider).toBe(true);
  });

  it('still does after a restart, when only the stranger’s message is known', async () => {
    // Everything turn-levels kept in memory is gone, as after a restart.
    vi.resetModules();
    const { ceilingForEntry } = await import('../../limits/turn-ceiling.js');
    const { noteEntryLevel, postLevelFor, lastTurnLevelOf, passedOnLevelOf } =
      await import('../../../core/turn-power/turn-levels.js');
    expect(passedOnLevelOf('new-seat-1')).toBeUndefined();
    const { runtime, sent } = await seam({
      'new-seat-1': 'bypassPermissions',
      bo: 'bypassPermissions',
    });

    // The moved seat's next turn is the re-run of the stranger's message.
    await run(runtime, 'new-seat-1', ceilingForEntry(AUTHORS, { id: 'e-1', authorId: 'stranger' }));
    noteEntryLevel('post-2', postLevelFor(['new-seat-1']));
    await run(
      runtime,
      'bo',
      ceilingForEntry(AUTHORS, { id: 'post-2', authorId: 'ana' }, false, '', { ownCircle: true })
    );

    expect(runsAt(sent.get('bo'))).toBe('bypassPermissions');
    expect(lastTurnLevelOf('bo')?.outsider).toBe(true);
  });
});

describe('Must 1: power only goes down', () => {
  it('keeps a seat set below Full where it was', async () => {
    for (const mode of ['default', 'acceptEdits', 'plan']) {
      const { m, settings } = mover({
        settingsOf: async (id) => (id === 'old-seat' ? { permissionMode: mode } : null),
      });
      await m.afterLimit(SEAT, `e-${mode}`, OPTS);
      expect(settings.get('new-seat-1')?.permissionMode).toBe(mode);
    }
  });
});

describe('Must 4: which accounts a seat may move to', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-reseat-accounts-'));
    claudeCode = {
      accounts: [
        { id: 'claude4', label: 'Claude4', path: '/accounts/claude4', onlyProjects: null },
        // The work account: kept to another project's folder.
        { id: 'claude-ab1', path: '/accounts/claude-ab1', onlyProjects: ['/projects/elsewhere'] },
        { id: 'claude2', label: 'Claude2', path: '/accounts/claude2', onlyProjects: null },
        { id: 'claude3', label: 'Claude3', path: '/accounts/claude3', onlyProjects: null },
      ],
    };
    const { setAccountUsageStore } = await import('../../../core/usage/current-usage-store.js');
    const ids = ['claude4', 'claude-ab1', CREDITS_ACCOUNT_ID, 'claude2', 'claude3'];
    const accounts = ids.map(
      (id) =>
        ({
          runtime: 'claude-code',
          id,
          path: `/accounts/${id}`,
          canonicalPath: `/accounts/${id}`,
          label: id,
          color: '#123456',
          storedColor: '#123456',
          routable: true,
          implicit: false,
          isDefault: false,
          ledgerId: id,
        }) as RuntimeAccount
    );
    setAccountUsageStore({
      listAccounts: () => accounts,
      usageOfAccount: (a: RuntimeAccount) => usage(a.id, a.id === 'claude4' || a.id === 'claude2'),
    } as unknown as AccountUsageStore);
  });

  afterEach(async () => {
    const { setAccountUsageStore } = await import('../../../core/usage/current-usage-store.js');
    setAccountUsageStore(undefined);
    await rm(root, { recursive: true, force: true });
  });

  /** A mover whose ranking is the production one: core's ranking for the folder's project. */
  async function realRankingMover() {
    const { coreRanking } = await import('../../../core/usage/account-ranking.js');
    const { projectOfFolder } = await import('../../../core/usage/account-eligibility.js');
    return mover({
      ranking: async (runtime, cwd) => coreRanking(runtime, await projectOfFolder(cwd)),
    });
  }

  it('picks only an allowed account with usage: never credits, the work account, or one that is out', async () => {
    const agentPath = path.join(root, 'ana');
    await mkdir(agentPath, { recursive: true });
    const { m } = await realRankingMover();
    const { accounts } = await m.options({ ...SEAT, agentPath });
    expect(accounts.map((a) => a.id)).not.toContain(CREDITS_ACCOUNT_ID);
    expect(accounts.map((a) => a.id)).not.toContain('claude-ab1');
    const moved = await m.afterLimit({ ...SEAT, agentPath }, 'e-1', OPTS);
    expect(moved).toMatchObject({ kind: 'moved', move: { reason: { to: 'claude3' } } });
  });

  it('is not changed by anything the agent writes in its own folder', async () => {
    const agentPath = path.join(root, 'ana');
    await mkdir(path.join(agentPath, '.dork'), { recursive: true });
    await mkdir(path.join(agentPath, '.claude'), { recursive: true });
    const { m } = await realRankingMover();
    const before = (await m.options({ ...SEAT, agentPath })).accounts.map((a) => [
      a.id,
      a.eligible,
    ]);

    // The agent names the work account and credits as its own, in every file it can reach.
    await writeFile(
      path.join(agentPath, '.dork', 'agent.json'),
      JSON.stringify({ id: 'ana', name: 'ana', account: 'claude-ab1', runtime: 'claude-code' })
    );
    await writeFile(
      path.join(agentPath, '.claude', 'settings.json'),
      JSON.stringify({
        account: CREDITS_ACCOUNT_ID,
        permissions: { defaultMode: 'bypassPermissions' },
      })
    );

    const after = (await m.options({ ...SEAT, agentPath })).accounts.map((a) => [a.id, a.eligible]);
    expect(after).toEqual(before);
  });
});

describe('Musts 5 and 6: the tool and the audit', () => {
  let capabilities: typeof import('../../../core/capabilities/index.js');
  let rooms: typeof import('../../room-capabilities.js');
  let roomHarness: typeof import('../../__tests__/room-test-harness.js');

  // The capability registry and the room harness are a large module graph, and
  // an earlier test resets modules, so they load cold here. Loading them inside
  // the test spent 4.4s of its 5s budget at load 11 and timed out at load 50
  // (#3216). The import is not what this block tests, so it gets its own budget.
  beforeAll(async () => {
    capabilities = await import('../../../core/capabilities/index.js');
    rooms = await import('../../room-capabilities.js');
    roomHarness = await import('../../__tests__/room-test-harness.js');
  }, 60_000);

  it('refuses an agent calling rooms.reseat, even with Rooms allowed, as people-only', async () => {
    const { composeRegistry, initPermissionGate, resetPermissionGate } = capabilities;
    const { roomsDomain } = rooms;
    const { agentLookupFor, createRoomHarness, scriptedRunner } = roomHarness;
    resetPermissionGate();
    initPermissionGate({
      readConfig: () => ({ preset: null, defaults: { areas: { rooms: 'allowed' }, actions: {} } }),
      readAgentPermissions: async () => ({ areas: { rooms: 'allowed' } }),
    });
    try {
      const harness = createRoomHarness({
        agents: agentLookupFor({ '/agents/ana': { name: 'ana', displayName: 'Ana' } }),
        runner: scriptedRunner(() => null),
      });
      const room = harness.service.createRoom(
        { kind: 'channel', title: 'Work', members: [], agentPaths: ['/agents/ana'] },
        harness.human
      );
      const ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
      const registry = composeRegistry([roomsDomain], {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        roomDeps: { rooms: harness.service },
      });
      const refused = registry.invoke(
        'rooms.reseat',
        { roomId: room.id, agentId: ana },
        {
          identity: {
            agentPath: '/agents/ana',
            displayName: 'Ana',
            createdAt: new Date().toISOString(),
          },
          retryChannel: 'mcp-argument',
        }
      );
      await expect(refused).rejects.toMatchObject({ payload: { code: 'PEOPLE_ONLY' } });
    } finally {
      resetPermissionGate();
    }
  });

  it('writes exactly one Activity entry per move, naming who, from, to and the message', async () => {
    const { recordReseatActivity } = await import('../create-seat-mover.js');
    const emitted: unknown[] = [];
    const activity = {
      emit: (event: unknown) => {
        emitted.push(event);
        return Promise.resolve();
      },
    } as never;
    const { m } = mover({ recordActivity: (entry) => recordReseatActivity(activity, entry) });

    await m.afterLimit(SEAT, 'e-1', OPTS);
    await m.afterLimit(SEAT, 'e-1', OPTS); // the same message: no second move
    await m.byHand(
      { ...SEAT, sessionId: 'new-seat-1' },
      { accountId: 'claude3', by: 'Dorian', hideAccounts: false }
    );

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      eventType: 'room.seat_moved',
      actorType: 'system',
      metadata: {
        trigger: 'limit',
        entryId: 'e-1',
        fromAccountId: 'claude4',
        toAccountId: 'claude3',
        fromSessionId: 'old-seat',
        toSessionId: 'new-seat-1',
      },
    });
    expect(emitted[1]).toMatchObject({
      actorType: 'user',
      actorLabel: 'Dorian',
      metadata: { trigger: 'person', by: 'Dorian', toAccountId: 'claude3' },
    });
  });
});
