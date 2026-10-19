/**
 * The one-time raise of existing chats (DOR-3107), against Security's tests: a
 * chat whose launch could have been marked stays capped, an unmarked one rises
 * to its agent's level and no higher, a second boot changes nothing, and one
 * Undo restores every mode.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import {
  isNoLooserThan,
  levelOfMode,
  resolveStopMode,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import type { AgentPermissions, PermissionChangedMetadata } from '@dorkos/shared/permissions';

import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  EXISTING_CHATS_NOTE,
  openingMessageMarked,
  raiseExistingChats,
  setChatModePort,
  type ChatModePort,
  type ExistingChatRow,
  type ExistingChatsRaiseDeps,
} from '../existing-chats-raise.js';
import { personWriter } from '../permission-history.js';
import { marksForTurn, withMarks } from '../../turn-power/turn-marks.js';
import { createPermissionWorld } from './permission-fixtures.js';

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes as DeclaredModes;
const modeAt = (stop: PermissionStop) => resolveStopMode(stop, MODES.values)!;
const FULL = modeAt('autonomy');
const ACT = modeAt('act');

const AGENTS = [
  { id: 'a-build', name: 'builder', projectPath: '/agents/builder' },
  { id: 'a-other', name: 'other', projectPath: '/agents/other' },
  { id: 'a-cloud', name: 'DorkOS Cloud', projectPath: '/work/dorkos-cloud' },
];

/** One chat row; an interactive chat of the builder at Default unless told otherwise. */
function chat(sessionId: string, over: Partial<ExistingChatRow> = {}): ExistingChatRow {
  return {
    sessionId,
    runtime: 'claude-code',
    agentPath: '/agents/builder',
    launchOrigin: 'interactive',
    permissionMode: 'default',
    ...over,
  };
}

/** A world: chat rows held in memory, written only through the port. */
function setup(
  rows: ExistingChatRow[],
  opts: {
    floors?: Record<string, AgentPermissions>;
    seeded?: boolean;
    defaultStop?: PermissionStop | null;
    agentStops?: Record<string, PermissionStop>;
    /** Chats whose write throws. */
    failing?: string[];
    /** Chats whose launch was marked or came from outside. */
    marked?: string[];
  } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-raise-'));
  const world = createPermissionWorld({ agents: AGENTS });
  const modes = new Map(rows.map((r) => [r.sessionId, r.permissionMode]));
  const writes: Array<[string, string | null]> = [];
  const port: ChatModePort = {
    modeOf: (id) => (modes.has(id) ? modes.get(id)! : 'gone'),
    setMode: async (id, mode) => {
      if (opts.failing?.includes(id)) throw new Error('runtime not registered');
      writes.push([id, mode]);
      modes.set(id, mode ?? MODES.default!);
    },
    isLooser: async (_id, candidate, than) => {
      const a = levelOfMode(MODES, candidate ?? MODES.default);
      const b = levelOfMode(MODES, than ?? MODES.default);
      return !a || !b || !isNoLooserThan(b, a);
    },
  };
  setChatModePort(port);
  const deps: ExistingChatsRaiseDeps = {
    doneFile: path.join(dir, 'permissions', 'existing-chats-raised.json'),
    // Rows as the database would hand them over at each boot.
    chats: () => rows.map((r) => ({ ...r, permissionMode: modes.get(r.sessionId) ?? null })),
    agents: () => AGENTS,
    launchMarked: (row) => opts.marked?.includes(row.sessionId) ?? false,
    personSet: {
      isSeeded: () => opts.seeded ?? true,
      get: (id) => opts.floors?.[id],
    },
    defaultStop: () => (opts.defaultStop === undefined ? 'autonomy' : opts.defaultStop),
    agentStop: async (agentPath) => opts.agentStops?.[agentPath],
    modes: (runtime) => (runtime === 'claude-code' ? MODES : undefined),
    port,
    activity: world.activity,
    priorRaise: async () =>
      world.events.some(
        (e) => (e.metadata as { note?: unknown } | null)?.note === EXISTING_CHATS_NOTE
      ),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { dir, world, modes, writes, deps };
}

let cleanup: string[] = [];
beforeEach(() => {
  cleanup = [];
});
afterEach(() => {
  setChatModePort(null);
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

describe('raiseExistingChats', () => {
  it('raises unmarked and unknown chats of our own agents; leaves outside and marked ones capped', async () => {
    const raised = [
      chat('mine'),
      chat('launched', { launchOrigin: 'agent-launch' }),
      chat('beat', { launchOrigin: 'heartbeat' }),
      chat('from-chat', { launchOrigin: 'chat-message' }),
      chat('local-room', { launchOrigin: 'room' }),
      chat('handoff', { launchOrigin: 'account-handoff' }),
      chat('unknown', { launchOrigin: null }),
    ];
    const kept = [
      chat('marked-chat', { launchOrigin: 'chat-message' }),
      chat('bridged-room', { launchOrigin: 'room' }),
      chat('telegram', { launchOrigin: 'relay-binding' }),
      chat('relay', { launchOrigin: 'session-relay' }),
      chat('outsider', { launchOrigin: 'outside-sender' }),
      chat('connector', { launchOrigin: 'connector-event' }),
      chat('dm', { launchOrigin: 'agent-dm' }),
      chat('extension', { launchOrigin: 'extension-start' }),
      chat('extension-msg', { launchOrigin: 'extension-message' }),
      chat('schedule', { launchOrigin: 'schedule' }),
      chat('harness', { launchOrigin: 'test-harness' }),
      chat('new-kind', { launchOrigin: 'something-new' }),
    ];
    const t = setup([...raised, ...kept], { marked: ['marked-chat', 'bridged-room'] });
    cleanup.push(t.dir);

    expect(await raiseExistingChats(t.deps)).toEqual({ raised: raised.length });

    for (const { sessionId } of raised) expect(t.modes.get(sessionId), sessionId).toBe(FULL);
    for (const { sessionId } of kept) expect(t.modes.get(sessionId), sessionId).toBe('default');
  });

  it('an unknown chat rises to the floor and no higher, like an unmarked one', async () => {
    const t = setup([chat('unknown', { launchOrigin: null }), chat('unmarked')], {
      floors: { 'a-build': { filesAndCommands: 'act' } },
    });
    cleanup.push(t.dir);

    await raiseExistingChats(t.deps);

    expect(t.modes.get('unknown')).toBe(ACT);
    expect(t.modes.get('unmarked')).toBe(ACT);
  });

  it('raises to the person-set floor, never to what the agent’s own file claims', async () => {
    const t = setup([chat('mine')], {
      floors: { 'a-build': { filesAndCommands: 'act' } },
      defaultStop: 'autonomy',
    });
    cleanup.push(t.dir);

    await raiseExistingChats(t.deps);

    expect(t.modes.get('mine')).toBe(ACT);
  });

  it('holds the level to the agent’s own settings when those are stricter', async () => {
    const t = setup([chat('mine')], {
      agentStops: { '/agents/builder': 'ask' },
    });
    cleanup.push(t.dir);

    expect(await raiseExistingChats(t.deps)).toEqual({ raised: 0 });
    expect(t.writes).toEqual([]);
  });

  it('never lowers a chat, never moves Plan, and leaves the kept agents and strangers alone', async () => {
    const t = setup(
      [
        chat('already-full', { permissionMode: FULL }),
        chat('plan', { permissionMode: 'plan' }),
        chat('never-ask', { permissionMode: 'dontAsk' }),
        chat('other-computer', { runtime: 'computer-local' }),
        chat('cloud', { agentPath: '/work/dorkos-cloud' }),
        chat('no-agent', { agentPath: '/somewhere/else' }),
        chat('no-runtime', { runtime: null }),
        chat('other-runtime', { runtime: 'mystery' }),
      ],
      { floors: { 'a-build': { filesAndCommands: 'act' } } }
    );
    cleanup.push(t.dir);

    expect(await raiseExistingChats(t.deps)).toEqual({ raised: 0 });
    expect(t.writes).toEqual([]);
  });

  it('does nothing when no default is configured', async () => {
    const t = setup([chat('mine')], { defaultStop: null });
    cleanup.push(t.dir);

    expect(await raiseExistingChats(t.deps)).toEqual({ raised: 0 });
    expect(t.modes.get('mine')).toBe('default');
  });

  it('runs once: a second boot changes nothing, even a chat a person lowered again', async () => {
    const t = setup([chat('mine')]);
    cleanup.push(t.dir);
    await raiseExistingChats(t.deps);
    expect(t.modes.get('mine')).toBe(FULL);

    // A person lowers it again; the next start must leave it there.
    t.modes.set('mine', 'default');
    t.writes.length = 0;

    expect(await raiseExistingChats(t.deps)).toBeNull();
    expect(t.writes).toEqual([]);
    expect(t.modes.get('mine')).toBe('default');
    expect(t.world.events).toHaveLength(1);
  });

  it('marks itself done even when nothing qualified', async () => {
    const t = setup([chat('telegram', { launchOrigin: 'relay-binding' })]);
    cleanup.push(t.dir);
    await raiseExistingChats(t.deps);
    expect(fs.existsSync(t.deps.doneFile)).toBe(true);
    expect(t.world.events).toHaveLength(0);
  });

  it('does not run, or mark itself done, while the person-set record is unseeded', async () => {
    const t = setup([chat('mine')], { seeded: false });
    cleanup.push(t.dir);

    expect(await raiseExistingChats(t.deps)).toBeNull();
    expect(t.modes.get('mine')).toBe('default');
    expect(fs.existsSync(t.deps.doneFile)).toBe(false);
  });

  it('records every chat’s old mode in ONE history event, under its agent', async () => {
    const t = setup([
      chat('one'),
      chat('two', { permissionMode: ACT }),
      chat('three', { permissionMode: null }),
      chat('other', { agentPath: '/agents/other' }),
    ]);
    cleanup.push(t.dir);

    await raiseExistingChats(t.deps);

    expect(t.world.events).toHaveLength(1);
    const event = t.world.events[0]!;
    expect(event).toMatchObject({
      eventType: 'permission.changed',
      actorLabel: 'Upgrade',
      summary: 'Files & commands changed in 4 existing chats',
    });
    const meta = event.metadata as unknown as PermissionChangedMetadata;
    expect(meta.surface).toBe('upgrade');
    expect(meta.note).toBe(EXISTING_CHATS_NOTE);
    expect(meta.changes.map((c) => [c.key, c.before, c.after])).toEqual([
      [{ kind: 'chat', sessionId: 'one' }, 'default', FULL],
      [{ kind: 'chat', sessionId: 'two' }, ACT, FULL],
      [{ kind: 'chat', sessionId: 'three' }, MODES.default, FULL],
      [{ kind: 'chat', sessionId: 'other' }, 'default', FULL],
    ]);
    expect(meta.changes[3]!.target).toMatchObject({ kind: 'agent', agentId: 'a-other' });
  });

  it('changes no chat when the history event cannot be written', async () => {
    const t = setup([chat('one'), chat('two')]);
    cleanup.push(t.dir);
    t.deps.activity = { emit: async () => Promise.reject(new Error('disk full')) };

    expect(await raiseExistingChats(t.deps)).toBeNull();
    expect(t.writes).toEqual([]);
    expect(fs.existsSync(t.deps.doneFile)).toBe(false);
  });

  it('changes no chat when the done file cannot be written, and the history line still marks it done', async () => {
    const t = setup([chat('one')]);
    cleanup.push(t.dir);
    // A directory where the done file's folder should be: the write fails.
    fs.writeFileSync(path.join(t.dir, 'permissions'), 'not a folder');

    expect(await raiseExistingChats(t.deps)).toBeNull();
    expect(t.writes).toEqual([]);
    expect(t.world.events).toHaveLength(1);

    // The next start sees the history line and runs nothing.
    expect(await raiseExistingChats(t.deps)).toBeNull();
    expect(t.writes).toEqual([]);
  });

  it('keeps going when one chat cannot be written; that chat keeps its mode', async () => {
    const t = setup([chat('one'), chat('broken'), chat('three')], { failing: ['broken'] });
    cleanup.push(t.dir);

    expect(await raiseExistingChats(t.deps)).toEqual({ raised: 2 });
    expect(t.modes.get('broken')).toBe('default');
    expect(t.modes.get('three')).toBe(FULL);
  });
});

describe('Undo of the raise', () => {
  const LOCAL = personWriter('local-trust');

  it('restores every chat’s mode in one step', async () => {
    const t = setup([
      chat('one'),
      chat('two', { permissionMode: ACT }),
      chat('three', { permissionMode: null }),
      chat('other', { agentPath: '/agents/other' }),
    ]);
    cleanup.push(t.dir);
    await raiseExistingChats(t.deps);
    const raised = t.world.events[0]!;

    const result = await t.world.service.undo(raised.id, {}, LOCAL);

    expect(t.modes.get('one')).toBe('default');
    expect(t.modes.get('two')).toBe(ACT);
    // No stored mode ran at the runtime's own default; that is what it gets back.
    expect(t.modes.get('three')).toBe(MODES.default);
    expect(t.writes.slice(-4).map(([, m]) => m)).not.toContain(null);
    expect(t.modes.get('other')).toBe('default');
    expect(result.skipped).toEqual([]);
    expect(result.changes).toHaveLength(4);
    const undo = t.world.events[1]!;
    expect(undo.summary).toBe('Undo: Files & commands changed in 4 existing chats');
    expect((undo.metadata as unknown as PermissionChangedMetadata).undoOf).toBe(raised.id);
  });

  it('leaves a chat a person changed since, and still sets the rest back', async () => {
    const t = setup([chat('one'), chat('two')]);
    cleanup.push(t.dir);
    await raiseExistingChats(t.deps);
    t.modes.set('two', 'acceptEdits');

    const result = await t.world.service.undo(t.world.events[0]!.id, {}, LOCAL);

    expect(t.modes.get('one')).toBe('default');
    expect(t.modes.get('two')).toBe('acceptEdits');
    expect(result.skipped).toEqual([
      expect.objectContaining({ current: 'acceptEdits', reason: 'changed-since' }),
    ]);
  });

  it('never raises a chat: the Undo of the Undo is refused per chat', async () => {
    const t = setup([chat('one')]);
    cleanup.push(t.dir);
    await raiseExistingChats(t.deps);
    await t.world.service.undo(t.world.events[0]!.id, {}, LOCAL);
    expect(t.modes.get('one')).toBe('default');

    const again = await t.world.service.undo(t.world.events[1]!.id, { force: true }, LOCAL);

    expect(t.modes.get('one')).toBe('default');
    expect(again.changes).toEqual([]);
    expect(again.skipped).toEqual([expect.objectContaining({ reason: 'floor' })]);
  });

  it('reports a chat it cannot write as skipped and sets the rest back', async () => {
    const t = setup([chat('one'), chat('broken'), chat('three')]);
    cleanup.push(t.dir);
    await raiseExistingChats(t.deps);
    const port = t.deps.port;
    setChatModePort({
      ...port,
      setMode: async (id, mode) => {
        if (id === 'broken') throw new Error('runtime not registered');
        return port.setMode(id, mode);
      },
    });

    const result = await t.world.service.undo(t.world.events[0]!.id, {}, LOCAL);

    expect(t.modes.get('one')).toBe('default');
    expect(t.modes.get('three')).toBe('default');
    expect(t.modes.get('broken')).toBe(FULL);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'gone' })]);
    expect(t.world.events).toHaveLength(2);
  });
});

describe('openingMessageMarked', () => {
  it('reads an outsider or teammate mark on the opening message as marked', () => {
    const level = { asks: 'never', reach: 'full' };
    expect(openingMessageMarked(JSON.stringify({ ...level, outsider: true }))).toBe(true);
    expect(
      openingMessageMarked(JSON.stringify({ ...level, teammate: [{ roomId: 'r', authorId: 'a' }] }))
    ).toBe(true);
  });

  it('reads what a sender held to the runtime default (a Wi-Fi turn) stores as marked', () => {
    // A Wi-Fi turn is sent with the 'runtime-default' ceiling (DOR-3037); its recorded level
    // takes that ceiling's marks, and a message it sends stores that level.
    const held = withMarks(
      { asks: 'always', reach: 'everything' },
      marksForTurn({ permissionCeiling: 'runtime-default' })
    );
    expect(openingMessageMarked(JSON.stringify(held))).toBe(true);
  });

  it('reads a list of bounds as marked when any of them carries a mark', () => {
    const level = { asks: 'never', reach: 'full' };
    expect(
      openingMessageMarked(JSON.stringify([{ ...level, outsider: true }, 'runtime-default']))
    ).toBe(true);
    expect(openingMessageMarked(JSON.stringify([level, 'runtime-default']))).toBe(false);
  });

  it('reads the runtime default, an unmarked level, no message or junk as not marked', () => {
    expect(openingMessageMarked(JSON.stringify('runtime-default'))).toBe(false);
    expect(openingMessageMarked(JSON.stringify({ asks: 'never', reach: 'full' }))).toBe(false);
    expect(openingMessageMarked(undefined)).toBe(false);
    expect(openingMessageMarked('not json')).toBe(false);
  });
});
