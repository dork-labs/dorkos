/**
 * The gatherers and the rules rung (spec `heartbeats` §5, §6.1), over a real
 * test database where they read one.
 */
import { describe, expect, it, beforeEach } from 'vitest';
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
  createCommitmentsGatherer,
  createHealthGatherer,
  createSchedulesGatherer,
  createWorkspaceGatherer,
  runGatherers,
  GATHER_MAX_CHANGES,
  type Change,
  type GatherContext,
  type RunCommand,
} from '../gatherers/index.js';
import { standingKey, triageByRules } from '../triage-rules.js';
import { AuditLog } from '../../audit/audit-log.js';
import { eq } from 'drizzle-orm';
import { noteEntryLevel } from '../../core/turn-power/turn-levels.js';

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

  it("never counts a stranger's message, even naming the agent", async () => {
    room('r-bridged', 'channel', 'telegram', ['a-juno', 'x-stranger']);
    post('r-bridged', 'x-stranger', '2026-10-12T09:10:00Z', ['a-juno']);
    expect(await createAddressedGatherer(db)(ctx())).toEqual([]);
  });

  it("counts another agent's post only when it names this agent", async () => {
    room('r-general', 'channel', 'general', ['a-juno', 'a-otto']);
    post('r-general', 'a-otto', '2026-10-12T09:10:00Z');
    expect(await createAddressedGatherer(db)(ctx())).toEqual([]);
    post('r-general', 'a-otto', '2026-10-12T09:11:00Z', ['a-juno']);
    expect(await createAddressedGatherer(db)(ctx())).toHaveLength(1);
  });

  // DOR-3036: a beat that reads a marked post carries its marks.
  it('carries the marks another agent’s post was written under, from memory or its row', async () => {
    room('r-general', 'channel', 'general', ['a-juno', 'a-otto']);
    const inMemory = post('r-general', 'a-otto', '2026-10-12T09:10:00Z', ['a-juno']);
    noteEntryLevel(inMemory, {
      asks: 'always',
      reach: 'read',
      outsider: true,
      teammate: [{ roomId: 'space', authorId: 'priya' }],
    });
    const onRow = post('r-general', 'a-otto', '2026-10-12T09:11:00Z', ['a-juno']);
    db.update(roomEntries)
      .set({ turnMarks: JSON.stringify({ outsider: true }) })
      .where(eq(roomEntries.id, onRow))
      .run();
    const plain = post('r-general', 'h-dorian', '2026-10-12T09:12:00Z', ['a-juno']);

    const byKey = new Map(
      (await createAddressedGatherer(db)(ctx())).map((change) => [change.key, change.marks])
    );
    expect(byKey.get(`room-entry:${inMemory}`)).toEqual({
      outsider: true,
      teammate: [{ roomId: 'space', authorId: 'priya' }],
    });
    expect(byKey.get(`room-entry:${onRow}`)).toEqual({ outsider: true });
    expect(byKey.get(`room-entry:${plain}`)).toBeUndefined();
  });

  it('keeps the newest messages on a busy day', async () => {
    room('r-general', 'channel', 'general', ['a-juno', 'a-otto']);
    for (let i = 0; i < 520; i += 1) {
      post('r-general', 'a-otto', new Date(Date.parse(SINCE) + 1000 + i * 1000).toISOString());
    }
    const latest = post('r-general', 'h-dorian', '2026-10-12T09:59:00Z', ['a-juno']);
    const changes = await createAddressedGatherer(db)(ctx());
    expect(changes.map((c) => c.key)).toEqual([`room-entry:${latest}`]);
  });

  it('drops a message the agent already answered, and one before the last beat', async () => {
    room('r-dm', 'dm', 'Dorian', ['a-juno', 'h-dorian']);
    post('r-dm', 'h-dorian', '2026-10-12T08:00:00Z');
    post('r-dm', 'h-dorian', '2026-10-12T09:10:00Z');
    post('r-dm', 'a-juno', '2026-10-12T09:15:00Z');
    expect(await createAddressedGatherer(db)(ctx())).toEqual([]);
  });
});

describe('commitments', () => {
  it('finds promises due within a day or overdue', async () => {
    const list = () =>
      [
        { id: 'c1', what: 'Quote to Acme', dueAt: '2026-10-12T08:00:00Z' },
        { id: 'c2', what: 'Invoice run', dueAt: '2026-10-12T20:00:00Z' },
        { id: 'c3', what: 'Next month', dueAt: '2026-11-12T20:00:00Z' },
        { id: 'c4', what: 'No date', dueAt: null },
      ] as never;
    const changes = await createCommitmentsGatherer({ list })(ctx());
    expect(changes.map((c) => [c.key, c.signal])).toEqual([
      ['commitment:c1', 'commitment-overdue'],
      ['commitment:c2', 'commitment-due'],
    ]);
  });
});

describe('schedules', () => {
  it('turns failed and parked runs into keyed changes', async () => {
    const changes = await createSchedulesGatherer(() => [
      { id: 'run1', taskName: 'Invoices', status: 'failed', at: '2026-10-12T09:30:00Z' },
      { id: 'run2', taskName: 'Digest', status: 'blocked', at: '2026-10-12T09:40:00Z' },
    ])(ctx());
    expect(changes.map((c) => c.key)).toEqual(['run:run1', 'run:run2']);
    expect(changes[1]!.summary).toMatch(/waiting for a person/);
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

  it("leaves out what the agent's own beat turns tripped over", async () => {
    new AuditLog(db).record({
      at: '2026-10-12T09:30:00.000Z',
      actor: { kind: 'agent', accountId: 'agent-juno', name: 'Juno' },
      source: { surface: 'mcp', sessionId: 'beat-chat' },
      action: 'connectors.execute',
      operation: 'execute',
      outcome: 'refused',
      summary: 'Refused.',
    } as never);
    const own = await createHealthGatherer(db)(ctx({ ownBeatSessions: new Set(['beat-chat']) }));
    expect(own).toEqual([]);
    const elsewhere = await createHealthGatherer(db)(ctx());
    expect(elsewhere.map((c) => c.signal)).toEqual(['self-refused']);
  });

  /** Record one failed runtime tool call by Juno, in her live chat. */
  function toolFailure(summary: string, error?: string, at = '2026-10-12T09:30:00.000Z'): void {
    new AuditLog(db).record({
      at,
      actor: { kind: 'agent', accountId: 'agent-juno', name: 'Juno' },
      source: { surface: 'runtime-tool', runtime: 'claude-code', sessionId: 'live-chat' },
      action: 'runtime.tool_used',
      operation: 'execute',
      outcome: 'failed',
      ...(error ? { error } : {}),
      summary,
    } as never);
  }

  it('reads an everyday tool failure in a chat as information, so triage stays quiet', async () => {
    toolFailure('Tried Bash (in a helper): grep -rn nothing-here src', 'Exit code 1');
    toolFailure('Tried Bash: pnpm foo --help');
    const changes = await createHealthGatherer(db)(ctx());
    expect(changes.map((c) => c.signal)).toEqual(['info', 'info']);
    expect(triageByRules(changes, { failureStorm: false }).verdict).toBe('quiet');
  });

  it('wakes on the same tool call failing again and again, helper or not', async () => {
    toolFailure('Tried Bash: pnpm build', undefined, '2026-10-12T09:10:00.000Z');
    toolFailure('Tried Bash (in a helper): pnpm build', undefined, '2026-10-12T09:20:00.000Z');
    toolFailure('Tried Bash: pnpm build', undefined, '2026-10-12T09:30:00.000Z');
    toolFailure('Tried Bash: pnpm lint', undefined, '2026-10-12T09:40:00.000Z');
    const changes = await createHealthGatherer(db)(ctx());
    expect(changes.map((c) => c.signal)).toEqual([
      'self-refused',
      'self-refused',
      'self-refused',
      'info',
    ]);
    expect(triageByRules(changes, { failureStorm: false }).verdict).toBe('undecided');
  });

  it('wakes on a full disk from any tool, and on access denied only to a file-writing tool', async () => {
    toolFailure('Tried Bash: npm install', 'ENOSPC: no space left on device, write');
    toolFailure('Tried Write: notes.md', "EACCES: permission denied, open 'notes.md'");
    toolFailure('Tried Bash: find / -name x', 'find: /private: Permission denied');
    const signals = (await createHealthGatherer(db)(ctx())).map((c) => c.signal);
    expect(signals.sort()).toEqual(['info', 'self-refused', 'self-refused']);
  });

  it('keeps a refusal in view behind a burst of harmless tool failures', async () => {
    new AuditLog(db).record({
      at: '2026-10-12T09:05:00.000Z',
      actor: { kind: 'agent', accountId: 'agent-juno', name: 'Juno' },
      source: { surface: 'mcp' },
      action: 'connectors.execute',
      operation: 'execute',
      outcome: 'refused',
      summary: 'Refused.',
    } as never);
    for (let i = 0; i < 30; i += 1) toolFailure(`Tried Bash: grep -rn term-${i} src`);
    const changes = await createHealthGatherer(db)(ctx());
    expect(changes).toHaveLength(20);
    expect(changes[0]!.signal).toBe('self-refused');
    expect(triageByRules(changes, { failureStorm: false }).verdict).toBe('undecided');
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

  it('skips an agent with no working directory', async () => {
    const run = fakeRun('main', '[]');
    expect(
      await createWorkspaceGatherer(run)(ctx({ agent: { ...ctx().agent, cwd: null } }))
    ).toEqual([]);
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

describe('workspace checks that do not answer', () => {
  it('caches nothing when gh fails, and asks again next beat', async () => {
    let gh = 0;
    const run = (async (command: string, args: string[]) => {
      if (command === 'gh') {
        gh += 1;
        throw new Error('no pull request');
      }
      const joined = args.join(' ');
      if (joined.startsWith('rev-parse --abbrev-ref')) return 'feature';
      if (joined.startsWith('symbolic-ref')) return 'origin/main';
      if (joined.startsWith('log')) return '';
      return 'x';
    }) as RunCommand;
    const gather = createWorkspaceGatherer(run, () => NOW.getTime());
    expect(await gather(ctx())).toEqual([]);
    await gather(ctx());
    expect(gh).toBe(2);
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

  it('is quiet with nothing, or only information', () => {
    expect(triageByRules([], { failureStorm: false }).verdict).toBe('quiet');
    expect(triageByRules([change('info')], { failureStorm: false }).verdict).toBe('quiet');
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

  it('reads a heavy day as quiet: a turn about it would add to it', () => {
    expect(triageByRules([change('usage-high')], { failureStorm: false }).verdict).toBe('quiet');
  });

  it('counts a standing condition once, and again only when it changes', () => {
    const lost = change('connection-lost');
    expect(triageByRules([lost], { failureStorm: false, seenStanding: new Set() }).verdict).toBe(
      'work'
    );
    const seen = new Set([standingKey(lost)]);
    expect(triageByRules([lost], { failureStorm: false, seenStanding: seen }).verdict).toBe(
      'quiet'
    );
    const changed = { ...lost, key: 'connection:c1:revoked' };
    expect(triageByRules([changed], { failureStorm: false, seenStanding: seen }).verdict).toBe(
      'work'
    );
  });

  it('lets its own beat failures trigger nothing during a failure storm', () => {
    expect(triageByRules([change('beat-failed')], { failureStorm: false }).verdict).toBe(
      'undecided'
    );
    expect(triageByRules([change('beat-failed')], { failureStorm: true }).verdict).toBe('quiet');
  });
});
