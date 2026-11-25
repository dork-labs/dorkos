/**
 * The gatherers and the rules rung (spec `heartbeats` §5, §6.1), over a real
 * test database where they read one.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  agentConnectionAttachments,
  authors,
  connections,
  connectorProviderInstances,
  roomEntries,
  roomMembers,
  rooms,
  type Db,
} from '@dorkos/db';
import {
  createAddressedGatherer,
  createTodosGatherer,
  createHealthGatherer,
  createSchedulesGatherer,
  createWorkspaceGatherer,
  runGatherers,
  GATHER_MAX_CHANGES,
  type Change,
  type GatherContext,
  type RunCommand,
} from '../gatherers/index.js';
import { triageByRules } from '../triage-rules.js';
import { AuditLog } from '../../audit/audit-log.js';
import { eq } from 'drizzle-orm';
import { env } from '../../../env.js';

// The Keychain guard in front of `gh` (DOR-4423) reads the test-runtime flag
// from the startup snapshot and live, and a developer's shell may export it.
const AMBIENT_TEST_RUNTIME = env.DORKOS_TEST_RUNTIME;
beforeEach(() => {
  env.DORKOS_TEST_RUNTIME = false;
  vi.stubEnv('DORKOS_TEST_RUNTIME', '');
});
afterEach(() => {
  env.DORKOS_TEST_RUNTIME = AMBIENT_TEST_RUNTIME;
  vi.unstubAllEnvs();
});

const NOW = new Date('2026-10-12T10:00:00Z');
const SINCE = '2026-10-12T09:00:00.000Z';
const AGENT_PATH = '/agents/juno';

/** A context for Juno. */
function ctx(overrides: Partial<GatherContext> = {}): GatherContext {
  return {
    agent: { id: 'agent-juno', name: 'Juno', projectPath: AGENT_PATH, cwd: '/work/juno' },
    since: SINCE,
    now: NOW,
    signal: new AbortController().signal,
    ownBeatSessions: new Set(),
    ...overrides,
  };
}

let db: Db;
let seq = 0;

/** Insert an author. */
function author(id: string, kind: string, naturalKey: string, displayName: string): void {
  db.insert(authors)
    .values({ id, kind, naturalKey, displayName, createdAt: '2026-10-01T00:00:00Z' })
    .run();
}

/** Insert a room with members. */
function room(id: string, kind: 'channel' | 'dm', title: string, members: string[]): void {
  db.insert(rooms)
    .values({
      id,
      kind,
      title,
      createdAt: '2026-10-01T00:00:00Z',
      lastActivityAt: '2026-10-01T00:00:00Z',
    } as never)
    .run();
  for (const authorId of members) {
    db.insert(roomMembers)
      .values({ roomId: id, authorId, responseMode: 'mentioned', joinedAt: '2026-10-01T00:00:00Z' })
      .run();
  }
}

/** Insert a post. */
function post(roomId: string, authorId: string, at: string, mentions: string[] = []): string {
  seq += 1;
  const id = `entry-${seq}`;
  db.insert(roomEntries)
    .values({
      roomId,
      seq,
      id,
      authorId,
      kind: 'post',
      body: JSON.stringify({ text: 'SECRET-BODY-TEXT' }),
      mentions: JSON.stringify(mentions),
      cascadeRoot: id,
      createdAt: at,
    })
    .run();
  return id;
}

beforeEach(() => {
  db = createTestDb();
  seq = 0;
  author('a-juno', 'agent', AGENT_PATH, 'Juno');
  author('a-otto', 'agent', '/agents/otto', 'Otto');
  author('h-dorian', 'human', 'owner:acct-1', 'Dorian');
  author('x-stranger', 'human', 'platform:telegram:bot1:555', 'Stranger');
});

describe('addressed', () => {
  it('finds a local mention and a DM, without copying any body', async () => {
    room('r-general', 'channel', 'general', ['a-juno', 'h-dorian', 'a-otto']);
    room('r-dm', 'dm', 'Dorian', ['a-juno', 'h-dorian']);
    const mention = post('r-general', 'h-dorian', '2026-10-12T09:10:00Z', ['a-juno']);
    const dm = post('r-dm', 'h-dorian', '2026-10-12T09:20:00Z');

    const changes = await createAddressedGatherer(db)(ctx());
    expect(changes.map((c) => c.key).sort()).toEqual(
      [`room-entry:${dm}`, `room-entry:${mention}`].sort()
    );
    expect(changes.every((c) => c.signal === 'unanswered')).toBe(true);
    expect(JSON.stringify(changes)).not.toContain('SECRET-BODY-TEXT');
  });

  it('never counts a post written from Wi-Fi, read from its row after a restart (DOR-3037)', async () => {
    room('r-dm', 'dm', 'Dorian', ['a-juno', 'h-dorian']);
    const held = post('r-dm', 'h-dorian', '2026-10-12T09:10:00Z');
    db.update(roomEntries).set({ heldToDefault: true }).where(eq(roomEntries.id, held)).run();
    const plain = post('r-dm', 'h-dorian', '2026-10-12T09:20:00Z');
    const changes = await createAddressedGatherer(db)(ctx());
    expect(changes.map((c) => c.key)).toEqual([`room-entry:${plain}`]);
  });

  it("never counts a stranger's message, even naming the agent", async () => {
    room('r-bridged', 'channel', 'telegram', ['a-juno', 'x-stranger']);
    post('r-bridged', 'x-stranger', '2026-10-12T09:10:00Z', ['a-juno']);
    expect(await createAddressedGatherer(db)(ctx())).toEqual([]);
  });
});

describe('todos', () => {
  it('finds promises due within a day or overdue', async () => {
    const list = () =>
      [
        { id: 'c1', what: 'Quote to Acme', dueAt: '2026-10-12T08:00:00Z' },
        { id: 'c2', what: 'Invoice run', dueAt: '2026-10-12T20:00:00Z' },
        { id: 'c3', what: 'Next month', dueAt: '2026-11-12T20:00:00Z' },
        { id: 'c4', what: 'No date', dueAt: null },
      ] as never;
    const changes = await createTodosGatherer({ list })(ctx());
    expect(changes.map((c) => [c.key, c.signal])).toEqual([
      ['commitment:c1', 'commitment-overdue'],
      ['commitment:c2', 'commitment-due'],
    ]);
  });

  it('names a start or check-in wake as new work under its own key (DOR-3034)', async () => {
    const list = () =>
      [
        { id: 'c1', what: 'Quote to Acme', dueAt: '2026-10-12T20:00:00Z' },
        { id: 'c2', what: 'Invoice run', dueAt: '2026-10-12T21:00:00Z' },
        { id: 'c3', what: 'Not woken yet', dueAt: '2026-10-12T22:00:00Z' },
      ] as never;
    const AT = '2026-10-12T09:30:00Z';
    const lastWakeOf = (id: string) =>
      id === 'c1'
        ? { phase: 'start' as const, at: AT, notYet: false }
        : id === 'c2'
          ? { phase: 'checkin' as const, at: AT, notYet: false }
          : null;
    const changes = await createTodosGatherer({ list, lastWakeOf })(ctx());
    expect(changes.map((c) => [c.key, c.signal])).toEqual([
      [`commitment:c1:start:${AT}`, 'commitment-start'],
      [`commitment:c2:checkin:${AT}`, 'commitment-start'],
      ['commitment:c3', 'commitment-due'],
    ]);
    expect(triageByRules(changes.slice(0, 1), { failureStorm: false }).verdict).toBe('work');
  });
});

describe('schedules', () => {
  it('turns failed and parked runs into keyed changes', async () => {
    const changes = await createSchedulesGatherer(() => [
      { id: 'run1', taskName: 'Invoices', status: 'failed', at: '2026-10-12T09:30:00Z' },
      { id: 'run2', taskName: 'Digest', status: 'needs_attention', at: '2026-10-12T09:40:00Z' },
    ])(ctx());
    expect(changes.map((c) => c.key)).toEqual(['run:run1', 'run:run2']);
    expect(changes[1]!.summary).toMatch(/needs a person/);
  });
});

describe('health', () => {
  it('reads its own refusals and a lost connection', async () => {
    new AuditLog(db).record({
      at: '2026-10-12T09:30:00.000Z',
      actor: { kind: 'agent', accountId: 'agent-juno', name: 'Juno' },
      source: { surface: 'mcp' },
      action: 'connectors.execute',
      operation: 'execute',
      outcome: 'refused',
      summary: 'Refused.',
    } as never);
    db.insert(connectorProviderInstances)
      .values({
        id: 'p1',
        type: 'composio',
        mode: 'managed',
        displayName: 'Composio',
        custody: 'managed',
        capabilityJson: '{}',
        status: 'available',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      } as never)
      .run();
    db.insert(connections)
      .values({
        id: 'conn1',
        providerInstanceId: 'p1',
        externalAccountRef: 'x',
        toolkit: 'gmail',
        label: 'Gmail',
        status: 'expired',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      } as never)
      .run();
    db.insert(agentConnectionAttachments)
      .values({ agentId: 'agent-juno', connectionId: 'conn1', attachedAt: '2026-10-01T00:00:00Z' })
      .run();

    const changes = await createHealthGatherer(db)(ctx());
    expect(changes.map((c) => c.signal).sort()).toEqual(['connection-lost', 'self-refused']);
  });
});

describe('workspace', () => {
  /** A fake git/gh. */
  function fakeRun(branch: string, checks: string): RunCommand & { gh: number } {
    const run = (async (command: string, args: string[]) => {
      if (command === 'gh') {
        run.gh += 1;
        return checks;
      }
      const joined = args.join(' ');
      if (joined.startsWith('rev-parse --is-inside')) return 'true';
      if (joined.startsWith('symbolic-ref')) return 'origin/main';
      if (joined.startsWith('config user.email')) return 'me@example.com';
      if (joined.startsWith('log')) {
        return [
          'aaa\tother@example.com\t2026-10-12T09:30:00Z\tFix the build',
          'bbb\tme@example.com\t2026-10-12T09:31:00Z\tMine',
        ].join('\n');
      }
      if (joined.startsWith('rev-parse --abbrev-ref')) return branch;
      throw new Error(`unexpected ${joined}`);
    }) as unknown as RunCommand & { gh: number };
    run.gh = 0;
    return run;
  }

  describe('on a Mac with the test runtime on (DOR-4423)', () => {
    const realPlatform = process.platform;
    const realTestRuntime = env.DORKOS_TEST_RUNTIME;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      env.DORKOS_TEST_RUNTIME = realTestRuntime;
    });

    it('never starts gh, which reads its sign-in from the Keychain', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      env.DORKOS_TEST_RUNTIME = true;
      const run = fakeRun('feature', JSON.stringify([{ name: 'test', bucket: 'fail' }]));
      const changes = await createWorkspaceGatherer(run, () => NOW.getTime())(ctx());
      expect(run.gh).toBe(0);
      expect(changes.map((c) => c.key)).toEqual(['commit:aaa']);
    });
  });

  it("reads someone else's commits, and a failing check on its own branch at most every 30 minutes", async () => {
    let clock = NOW.getTime();
    const run = fakeRun(
      'feature',
      JSON.stringify([
        { name: 'test', bucket: 'fail' },
        { name: 'lint', bucket: 'pass' },
      ])
    );
    const gather = createWorkspaceGatherer(run, () => clock);
    const first = await gather(ctx());
    expect(first.map((c) => c.key)).toEqual(['commit:aaa', 'check:feature:test']);
    // Somebody else's commit subject is never quoted.
    expect(JSON.stringify(first)).not.toContain('Fix the build');
    clock += 10 * 60_000;
    await gather(ctx());
    expect(run.gh).toBe(1);
    clock += 30 * 60_000;
    await gather(ctx());
    expect(run.gh).toBe(2);
  });
});

describe('runGatherers', () => {
  it('turns a throwing or slow gatherer into a health change, and caps the total', async () => {
    const many = async (): Promise<Change[]> =>
      Array.from({ length: 80 }, (_, i) => ({
        gatherer: 'addressed' as const,
        key: `k${i}`,
        summary: 's',
        at: NOW.toISOString(),
        signal: 'unanswered' as const,
      }));
    const result = await runGatherers(
      {
        addressed: many,
        schedules: async () => {
          throw new Error('boom');
        },
      },
      ['addressed', 'schedules', 'workspace'],
      { agent: ctx().agent, since: SINCE, now: NOW, ownBeatSessions: new Set() }
    );
    expect(result.changes).toHaveLength(GATHER_MAX_CHANGES);
    expect(result.counts.addressed).toBe(80);
    expect(result.counts.health).toBe(1);
  });
});

describe('triageByRules', () => {
  const change = (signal: Change['signal'], touches?: Change['touches']): Change => ({
    gatherer: 'health',
    key: `${signal}-${touches?.join() ?? ''}`,
    summary: 's',
    at: NOW.toISOString(),
    signal,
    ...(touches ? { touches } : {}),
  });

  it('works on an unanswered message, an overdue promise, a failed run, a lost connection, a failing check', () => {
    for (const signal of [
      'unanswered',
      'commitment-overdue',
      'run-failed',
      'connection-lost',
      'check-failed',
    ] as const) {
      expect(triageByRules([change(signal)], { failureStorm: false }).verdict).toBe('work');
    }
  });

  it('is undecided about anything else, and about anything touching money', () => {
    expect(triageByRules([change('commits')], { failureStorm: false }).verdict).toBe('undecided');
    expect(triageByRules([change('info', ['money'])], { failureStorm: false }).verdict).toBe(
      'undecided'
    );
  });
});
