/**
 * The note a person's change to a level carries (DOR-3175): how many existing
 * chats meet it at their next turn, counted by direction. QA's setup: Ana has
 * four chats (room A, a marked room, G in a nested subfolder, H in a sibling
 * worktree). A cap reaches all four; lifting it raises the three unmarked ones.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import type { PermissionChange } from '@dorkos/shared/permissions';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import type { LevelAgent } from '../../turn-power/agent-level-bound.js';
import { createLevelReachNote, type LevelChatRow } from '../level-reach-note.js';

const ANA = '/agents/ana';
const BOB = '/agents/bob';

/** A Claude Code chat of Ana's at `mode`. */
function chat(sessionId: string, mode: string | null, agentPath = ANA): LevelChatRow {
  return { sessionId, runtime: 'claude-code', permissionMode: mode, agentPath, cwd: null };
}

/** A person's change to an agent's own Files & commands stop. */
function agentChange(
  before: PermissionStop | null,
  after: PermissionStop | null,
  agentPath = ANA
): PermissionChange {
  return {
    target: { kind: 'agent', agentId: agentPath, agentPath, agentName: 'Ana' },
    key: { kind: 'files' },
    before,
    after,
  } as PermissionChange;
}

/** A world: these chats, Ana's own stop now, the global stop now. */
function world(opts: {
  chats: LevelChatRow[];
  own: Record<string, PermissionStop | null>;
  global?: PermissionStop | null;
  agents?: Record<string, LevelAgent>;
  marked?: string[];
  byHand?: string[];
}) {
  return createLevelReachNote({
    chats: () => opts.chats,
    agentOf: (row) =>
      opts.agents?.[row.sessionId] ??
      (row.agentPath ? { agentPath: row.agentPath, exact: true } : undefined),
    modes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
    ownStop: async (agentPath) => opts.own[agentPath] ?? null,
    defaultStops: () => ({ global: opts.global ?? 'autonomy', perRuntime: {} }),
    marked: (id) => (opts.marked ?? []).includes(id),
    personSet: (id) => (opts.byHand ?? []).includes(id),
    titleOf: async (id) => (id === 'untitled' ? null : id),
  });
}

/** QA's four chats, all born at Full. */
const QA_CHATS = [
  chat('room-a', 'bypassPermissions'),
  chat('room-marked', 'bypassPermissions'),
  chat('chat-g', 'bypassPermissions'),
  chat('chat-h', 'bypassPermissions'),
];
const QA_AGENTS: Record<string, LevelAgent> = {
  'chat-g': { agentPath: ANA, exact: false },
};

describe('the level-reach note (DOR-3175)', () => {
  it('a cap counts every chat it reaches, the marked one included', async () => {
    const note = world({
      chats: QA_CHATS,
      own: { [ANA]: 'ask' },
      agents: QA_AGENTS,
      marked: ['room-marked'],
    });
    expect(await note([agentChange(null, 'ask')])).toBe('4 chats follow it');
  });

  it('lifting it counts only the chats that go up, not the marked one', async () => {
    const note = world({
      chats: QA_CHATS,
      own: { [ANA]: 'autonomy' },
      agents: QA_AGENTS,
      marked: ['room-marked'],
    });
    // G stands in a subfolder (a folder match): it never rises past its stored
    // mode, but its stored mode is Full, so lifting the cap lifts it too.
    expect(await note([agentChange('ask', 'autonomy')])).toBe(
      '3 chats rose (room-a, chat-g, chat-h)'
    );
  });

  it('a raise names the chats set by hand that stay lower', async () => {
    const note = world({
      chats: [chat('seeded', 'default'), chat('by-hand', 'default')],
      own: { [ANA]: 'autonomy' },
      byHand: ['by-hand'],
    });
    expect(await note([agentChange('ask', 'autonomy')])).toBe(
      '1 chat rose (seeded), 1 set by hand stay lower'
    );
  });

  it('names the first ten that rose, then how many more', async () => {
    const chats = Array.from({ length: 12 }, (_, i) => chat(`c${i + 1}`, 'default'));
    chats.push(chat('untitled', 'default'));
    const note = world({ chats, own: { [ANA]: 'autonomy' } });
    expect(await note([agentChange('ask', 'autonomy')])).toBe(
      '13 chats rose (c1, c2, c3, c4, c5, c6, c7, c8, c9, c10 +3 more)'
    );
  });

  it('holds a chat in another agent’s folder to the stricter of both', async () => {
    const note = world({
      chats: [chat('a-in-b', 'bypassPermissions')],
      own: { [ANA]: 'autonomy', [BOB]: 'ask' },
      agents: { 'a-in-b': { agentPath: ANA, exact: false, alsoBoundBy: BOB } },
    });
    // Ana going up changes nothing: Bob's Ask still holds the chat.
    expect(await note([agentChange('ask', 'autonomy')])).toBeUndefined();
    // Bob going down reaches it.
    expect(await note([agentChange('autonomy', 'ask', BOB)])).toBe('1 chat follows it');
  });

  it('a global change reaches the chats of agents with no stop of their own', async () => {
    const note = world({
      chats: [chat('ana-1', 'bypassPermissions'), chat('bob-1', 'bypassPermissions', BOB)],
      own: { [ANA]: null, [BOB]: 'autonomy' },
      global: 'ask',
    });
    const global = {
      target: { kind: 'default' },
      key: { kind: 'files' },
      before: 'autonomy',
      after: 'ask',
    } as PermissionChange;
    expect(await note([global])).toBe('1 chat follows it');
  });

  it('carries no note when no chat changes, or the change moves no level', async () => {
    const note = world({ chats: [chat('c', 'plan')], own: { [ANA]: 'ask' } });
    expect(await note([agentChange(null, 'ask')])).toBeUndefined();
    expect(
      await note([
        {
          target: { kind: 'agent', agentId: 'ana', agentPath: ANA, agentName: 'Ana' },
          key: { kind: 'area', area: 'rooms' },
          before: null,
          after: 'ask',
        } as PermissionChange,
      ])
    ).toBeUndefined();
  });
});
