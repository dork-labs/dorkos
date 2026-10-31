/**
 * The running-chats read (DOR-3460): who counts as running, which agent owns a
 * chat, and what an agent reader may see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import {
  initSessionVisibility,
  resetSessionVisibility,
  type SessionVisibility,
} from '../../../audit/session-visibility.js';
import { OWNER_READER, type AuditReader } from '../../../audit/visibility.js';
import { listRunningChats, type RunningChatSources } from '../running-chats.js';

const AGENT_READER: AuditReader = { kind: 'agent', accountId: 'unidentified' };

const ROSTER = {
  listWithPaths: () =>
    [
      { id: 'a-code', name: 'code', displayName: 'DorkOS Code', projectPath: '/keep/dorkos' },
      { id: 'a-cloud', name: 'cloud', displayName: null, projectPath: '/keep/cloud' },
      { id: 'a-idle', name: 'idle', displayName: 'Idle', projectPath: '/keep/idle' },
      { id: 'a-nested', name: 'nested', displayName: null, projectPath: '/keep/dorkos/apps/x' },
    ] as never[],
};

function status(lifecycle: string, limit?: unknown): SessionStatus {
  return { lifecycle, ...(limit ? { limit } : {}) } as unknown as SessionStatus;
}

function sources(overrides: Partial<RunningChatSources> = {}): RunningChatSources {
  return {
    statuses: () => [],
    needsYou: () => false,
    agentPathOf: async () => null,
    titleOf: async (id) => `Title of ${id}`,
    starterOf: () => null,
    ...overrides,
  };
}

function live(...ids: string[]) {
  return ids.map((sessionId) => ({
    sessionId,
    cwd: '/keep/dorkos',
    status: status('streaming'),
  }));
}

describe('listRunningChats', () => {
  beforeEach(() => {
    const known: Record<string, SessionVisibility> = {
      spin: 'space',
      parent: 'space',
      mine: 'participants',
    };
    initSessionVisibility(
      (ids) => new Map(ids.map((id) => [id, known[id] ?? ('participants' as const)]))
    );
  });
  afterEach(() => resetSessionVisibility());

  it('counts a working chat and a chat waiting on an answer, nothing else', async () => {
    const result = await listRunningChats(
      ROSTER,
      OWNER_READER,
      sources({
        statuses: () => [
          { sessionId: 'working', cwd: '/keep/dorkos', status: status('streaming') },
          { sessionId: 'asked', cwd: '/keep/dorkos', status: status('idle') },
          { sessionId: 'blocked', cwd: '/keep/dorkos', status: status('blocked') },
          { sessionId: 'finished', cwd: '/keep/dorkos', status: status('idle') },
          { sessionId: 'failed', cwd: '/keep/dorkos', status: status('error') },
          { sessionId: 'stopped', cwd: '/keep/dorkos', status: status('interrupted') },
          { sessionId: 'limited', cwd: '/keep/dorkos', status: status('idle', { at: 1 }) },
        ],
        needsYou: (id) => id === 'asked',
      })
    );

    const code = result.agents.find((a) => a.agentId === 'a-code')!;
    expect(code.chats.map((c) => [c.id, c.state])).toEqual([
      ['asked', 'needs-you'],
      ['blocked', 'needs-you'],
      ['working', 'running'],
    ]);
    expect(result.total).toBe(3);
  });

  it('shows two spin-offs under their agent while they run, and drops them when done', async () => {
    let running = ['spin-1', 'spin-2'];
    const spun = sources({
      statuses: () => live(...running),
      starterOf: () => 'parent',
      agentPathOf: async () => '/keep/dorkos',
    });

    const during = await listRunningChats(ROSTER, OWNER_READER, spun);
    const code = during.agents[0]!;
    expect(code.agentId).toBe('a-code');
    expect(code.count).toBe(2);
    expect(code.chats.map((c) => c.spinOff)).toEqual([true, true]);
    expect(code.chats[0]).toMatchObject({
      title: 'Title of spin-1',
      link: '[Title of spin-1](/session?session=spin-1)',
      startedBy: { id: 'parent', title: 'Title of parent' },
    });

    running = [];
    const after = await listRunningChats(ROSTER, OWNER_READER, spun);
    expect(after.total).toBe(0);
    expect(after.agents.every((a) => a.count === 0)).toBe(true);
  });

  it('lists every agent, zero included, busiest first, and total adds up', async () => {
    const result = await listRunningChats(
      ROSTER,
      OWNER_READER,
      sources({
        statuses: () => [
          ...live('a', 'b'),
          { sessionId: 'c', cwd: '/keep/cloud', status: status('streaming') },
          { sessionId: 'd', cwd: '/elsewhere', status: status('streaming') },
        ],
      })
    );

    expect(result.agents.map((a) => [a.name, a.count])).toEqual([
      ['DorkOS Code', 2],
      ['cloud', 1],
      ['Idle', 0],
      ['nested', 0],
    ]);
    expect(result.unassigned.count).toBe(1);
    expect(result.total).toBe(4);
  });

  it('prefers the bound agent, else the deepest folder holding the cwd', async () => {
    const result = await listRunningChats(
      ROSTER,
      OWNER_READER,
      sources({
        statuses: () => [
          // A lane in a temporary worktree still belongs to its agent.
          { sessionId: 'lane', cwd: '/tmp/worktree', status: status('streaming') },
          { sessionId: 'deep', cwd: '/keep/dorkos/apps/x/src', status: status('streaming') },
          // A binding to a folder that is no longer an agent falls back to the cwd.
          { sessionId: 'gone', cwd: '/keep/cloud', status: status('streaming') },
        ],
        agentPathOf: async (id) =>
          id === 'lane' ? '/keep/dorkos' : id === 'gone' ? '/removed' : null,
      })
    );

    const owners = Object.fromEntries(
      result.agents.map((a) => [a.agentId, a.chats.map((c) => c.id)])
    );
    expect(owners['a-code']).toEqual(['lane']);
    expect(owners['a-nested']).toEqual(['deep']);
    expect(owners['a-cloud']).toEqual(['gone']);
  });

  it('tells an agent a private chat is there, and nothing about it', async () => {
    const titles: string[] = [];
    const result = await listRunningChats(
      ROSTER,
      AGENT_READER,
      sources({
        statuses: () => live('mine', 'spin'),
        titleOf: async (id) => {
          titles.push(id);
          return `Title of ${id}`;
        },
        starterOf: (id) => (id === 'spin' ? 'mine' : null),
      })
    );

    const code = result.agents.find((a) => a.agentId === 'a-code')!;
    expect(code.count).toBe(2);
    expect(code.privateCount).toBe(1);
    expect(code.chats.map((c) => c.id)).toEqual(['spin']);
    // It started from a person's chat: a spin-off, with the parent unnamed.
    expect(code.chats[0]).toMatchObject({ spinOff: true, startedBy: null });
    expect(titles).not.toContain('mine');
    expect(JSON.stringify(result)).not.toContain('Title of mine');
  });

  it('shows the owner a private chat in full', async () => {
    const result = await listRunningChats(
      ROSTER,
      OWNER_READER,
      sources({ statuses: () => live('mine') })
    );

    const code = result.agents.find((a) => a.agentId === 'a-code')!;
    expect(code.privateCount).toBe(0);
    expect(code.chats.map((c) => c.id)).toEqual(['mine']);
  });

  it('with Mesh off, everything is unassigned and still counted', async () => {
    const result = await listRunningChats(
      undefined,
      OWNER_READER,
      sources({ statuses: () => live('a') })
    );

    expect(result.agents).toEqual([]);
    expect(result.unassigned.count).toBe(1);
    expect(result.total).toBe(1);
  });
});
