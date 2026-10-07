/**
 * Power flows downstream, never up (spec `trusted-by-default-flip` §4): the
 * level a turn runs at is recorded as it is sent, kept with each room post its
 * author writes, and read back as the ceiling of the turn that post starts.
 *
 * The chain case is the reason this exists. A conversation set to Full
 * autonomy that a stranger's message woke runs that turn at the runtime's
 * default. If it posts into a room, the turn its post starts on another agent
 * must be held to that default too — not to the poster's Full autonomy row,
 * which would launder the stranger's message into a shell one hop later.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  entryLevelOf,
  lastTurnLevelOf,
  noteEntryLevel,
  recordTurnLevels,
  resetTurnLevelsForTests,
  TURN_LEVEL_MEMORY,
} from '../turn-levels.js';
import { ceilingForEntry } from '../../../rooms/room-trigger.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';

const DEFAULT = { asks: 'always', reach: 'edit' };
const ACCEPT_EDITS = { asks: 'when-risky', reach: 'edit' };
const FULL = { asks: 'never', reach: 'everything' };

/** A runtime that answers every send with one `done`, wrapped the way the registry wraps it. */
function wrapped(stored: Record<string, string | null>): AgentRuntime {
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return recordTurnLevels(runtime, (id) => stored[id] ?? null);
}

async function send(runtime: AgentRuntime, sessionId: string, opts?: MessageOpts) {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** An author registry holding exactly the given authors. */
function authors(
  records: Record<string, { kind: 'human' | 'agent' | 'system'; naturalKey: string }>
): AuthorRegistry {
  return {
    getMany: (ids: readonly string[]) =>
      new Map(ids.filter((id) => records[id]).map((id) => [id, records[id]!])),
  } as unknown as AuthorRegistry;
}

const REGISTRY = authors({
  ana: { kind: 'agent', naturalKey: '/agents/ana' },
  dorian: { kind: 'human', naturalKey: 'operator' },
  stranger: { kind: 'human', naturalKey: 'platform:telegram:4242' },
});

beforeEach(() => resetTurnLevelsForTests());

describe('the level a turn runs at', () => {
  it('is the stored mode when the turn carries no ceiling', async () => {
    await send(wrapped({ s1: 'bypassPermissions' }), 's1');
    expect(lastTurnLevelOf('s1')).toEqual(FULL);
  });

  it('is held to the turn’s ceiling, whatever is stored', async () => {
    await send(wrapped({ s1: 'bypassPermissions' }), 's1', {
      permissionCeiling: 'runtime-default',
    });
    expect(lastTurnLevelOf('s1')).toEqual(DEFAULT);
  });

  it('reads an unconfirmed Auto as Default, and nothing stored as the runtime default', async () => {
    const runtime = wrapped({ auto: 'auto' });
    await send(runtime, 'auto');
    await send(runtime, 'none');
    expect(lastTurnLevelOf('auto')).toEqual(DEFAULT);
    expect(lastTurnLevelOf('none')).toEqual(DEFAULT);
  });

  it('takes the stricter of the stored mode and a per-send one', async () => {
    await send(wrapped({ s1: 'bypassPermissions' }), 's1', { permissionMode: 'acceptEdits' });
    expect(lastTurnLevelOf('s1')).toEqual(ACCEPT_EDITS);
  });

  it('remembers a bounded number of conversations, oldest forgotten first', async () => {
    const runtime = wrapped({});
    for (let i = 0; i <= TURN_LEVEL_MEMORY; i += 1) await send(runtime, `s${i}`);
    expect(lastTurnLevelOf('s0')).toBeUndefined();
    expect(lastTurnLevelOf(`s${TURN_LEVEL_MEMORY}`)).toEqual(DEFAULT);
  });
});

describe('a room post keeps its author’s level', () => {
  it('keeps the level of the turn that wrote it, not of a later one', async () => {
    const runtime = wrapped({ ana: 'bypassPermissions' });
    await send(runtime, 'ana', { permissionCeiling: 'runtime-default' });
    noteEntryLevel('entry-1', 'ana');
    // A person then talks to the same conversation at its own level.
    await send(runtime, 'ana');
    expect(entryLevelOf('entry-1')).toEqual(DEFAULT);
  });

  it('keeps nothing for a post with no session, or one this process never ran', () => {
    noteEntryLevel('entry-1', null);
    noteEntryLevel('entry-2', 'never-ran');
    expect(entryLevelOf('entry-1')).toBeUndefined();
    expect(entryLevelOf('entry-2')).toBeUndefined();
  });
});

describe('the ceiling a room entry puts on the turn it starts', () => {
  it('holds a stranger’s message to the runtime default', () => {
    expect(ceilingForEntry(REGISTRY, { id: 'e', authorId: 'stranger' })).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('holds an author nobody can resolve to the runtime default', () => {
    expect(ceilingForEntry(REGISTRY, { id: 'e', authorId: 'nobody' })).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('puts no bound on a person on this machine', () => {
    expect(ceilingForEntry(REGISTRY, { id: 'e', authorId: 'dorian' })).toEqual({});
  });

  it('holds an agent’s post to the level its turn ran at', async () => {
    await send(wrapped({ ana: 'acceptEdits' }), 'ana');
    noteEntryLevel('e-ana', 'ana');
    expect(ceilingForEntry(REGISTRY, { id: 'e-ana', authorId: 'ana' })).toEqual({
      permissionCeiling: ACCEPT_EDITS,
    });
  });

  it('holds an agent’s post whose level was not kept to the runtime default', () => {
    expect(ceilingForEntry(REGISTRY, { id: 'unkept', authorId: 'ana' })).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('carries a stranger’s bound through an agent at Full autonomy to the next agent', async () => {
    // Ana's conversation is at Full autonomy. A stranger's message wakes it:
    // that turn runs at the default. Ana posts; Ben's turn is held to that
    // default, never to Ana's Full autonomy row.
    const runtime = wrapped({ ana: 'bypassPermissions' });
    await send(runtime, 'ana', ceilingForEntry(REGISTRY, { id: 'e0', authorId: 'stranger' }));
    noteEntryLevel('e-ana', 'ana');
    expect(ceilingForEntry(REGISTRY, { id: 'e-ana', authorId: 'ana' })).toEqual({
      permissionCeiling: DEFAULT,
    });
  });
});
