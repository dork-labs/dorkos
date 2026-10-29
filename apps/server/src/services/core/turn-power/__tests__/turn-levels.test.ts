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
import { afterEach, describe, it, expect } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  entryLevelOf,
  lastTurnLevelOf,
  aliasTurnLevel,
  noteEntryLevel,
  postLevelFor,
  recordTurnLevels,
  TURN_LEVEL_MEMORY,
} from '../turn-levels.js';
import { ceilingForEntries, ceilingForEntry } from '../../../rooms/limits/turn-ceiling.js';
import { noteTurnOrigin } from '../../../session/origin/outsider-turns.js';
import {
  ceilingForContinuation,
  lastTurnHeld,
  noteTurnHold,
  setContinuationHoldDb,
} from '../continuation-hold.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';

const DEFAULT = { asks: 'always', reach: 'edit' };
const ACCEPT_EDITS = { asks: 'when-risky', reach: 'edit' };
const FULL = { asks: 'never', reach: 'everything' };
/** Default, recorded from a turn that read an outsider's words (§4.7). */
const DEFAULT_OUTSIDER = { ...DEFAULT, outsider: true };
/** Full, carrying an outsider's words on (DOR-3390): also the bound the mark rides as. */
const FULL_OUTSIDER = { ...FULL, outsider: true };

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

/** A fresh id per call: the record is process-wide, so tests never share keys. */
let counter = 0;
const fresh = (name: string) => `${name}-${(counter += 1)}`;

describe('the level a turn runs at', () => {
  it('is the stored mode when the turn carries no ceiling', async () => {
    const s1 = fresh('s');
    await send(wrapped({ [s1]: 'bypassPermissions' }), s1);
    expect(lastTurnLevelOf(s1)).toEqual(FULL);
  });

  it('is held to the turn’s ceiling, whatever is stored', async () => {
    const s1 = fresh('s');
    await send(wrapped({ [s1]: 'bypassPermissions' }), s1, {
      permissionCeiling: 'runtime-default',
    });
    expect(lastTurnLevelOf(s1)).toEqual(DEFAULT_OUTSIDER);
  });

  it('is held to every bound of a list ceiling at once', async () => {
    const s1 = fresh('s');
    await send(wrapped({ [s1]: 'bypassPermissions' }), s1, {
      permissionCeiling: [FULL as never, 'runtime-default'],
    });
    expect(lastTurnLevelOf(s1)).toEqual(DEFAULT_OUTSIDER);
  });

  it('reads an unconfirmed Auto as Default, and nothing stored as the runtime default', async () => {
    const auto = fresh('auto');
    const none = fresh('none');
    const runtime = wrapped({ [auto]: 'auto' });
    await send(runtime, auto);
    await send(runtime, none);
    expect(lastTurnLevelOf(auto)).toEqual(DEFAULT);
    expect(lastTurnLevelOf(none)).toEqual(DEFAULT);
  });

  it('takes the stricter of the stored mode and a per-send one', async () => {
    const s1 = fresh('s');
    await send(wrapped({ [s1]: 'bypassPermissions' }), s1, { permissionMode: 'acceptEdits' });
    expect(lastTurnLevelOf(s1)).toEqual(ACCEPT_EDITS);
  });

  it('follows a session the runtime renamed mid-turn', async () => {
    const placeholder = fresh('placeholder');
    const canonical = fresh('canonical');
    await send(wrapped({ [placeholder]: 'acceptEdits' }), placeholder);
    aliasTurnLevel(placeholder, canonical);
    expect(lastTurnLevelOf(canonical)).toEqual(ACCEPT_EDITS);
  });

  it('remembers a bounded number of conversations, oldest forgotten first', async () => {
    const runtime = wrapped({});
    const prefix = fresh('bound');
    for (let i = 0; i <= TURN_LEVEL_MEMORY; i += 1) await send(runtime, `${prefix}-${i}`);
    expect(lastTurnLevelOf(`${prefix}-0`)).toBeUndefined();
    expect(lastTurnLevelOf(`${prefix}-${TURN_LEVEL_MEMORY}`)).toEqual(DEFAULT);
  });
});

describe('the level a post is kept with', () => {
  it('keeps the level of the turn that wrote it, not of a later one', async () => {
    const ana = fresh('ana');
    const entry = fresh('entry');
    const runtime = wrapped({ [ana]: 'bypassPermissions' });
    await send(runtime, ana, { permissionCeiling: 'runtime-default' });
    noteEntryLevel(entry, postLevelFor([ana]));
    // A person then talks to the same conversation at its own level.
    await send(runtime, ana);
    // Ana's own level without the stranger's hold, marked (DOR-3390).
    expect(entryLevelOf(entry)).toEqual(FULL_OUTSIDER);
  });

  it('is the stricter of the calling session and the author’s turn in the room', async () => {
    // Ana has an Accept edits turn in R2 and a stranger-held Full turn in R1;
    // posting from R1's turn into R2 keeps R2's lower level and R1's mark.
    const inR1 = fresh('ana-r1');
    const inR2 = fresh('ana-r2');
    const runtime = wrapped({ [inR1]: 'bypassPermissions', [inR2]: 'acceptEdits' });
    await send(runtime, inR1, { permissionCeiling: 'runtime-default' });
    await send(runtime, inR2);
    expect(postLevelFor([inR1, inR2])).toEqual({ ...ACCEPT_EDITS, outsider: true });
  });

  // DOR-3107 review: a turn a connector event started (an email arriving) has
  // no ceiling, so its level alone would read as unmarked. Its post carries the
  // outsider mark, so the turn it wakes is capped.
  it('marks a post from a turn an outsider started, even with no ceiling', async () => {
    const started = fresh('connector-turn');
    noteTurnOrigin(started, { kind: 'connector-event' });
    await send(wrapped({ [started]: 'bypassPermissions' }), started);
    expect(postLevelFor([started])).toMatchObject({ outsider: true });
  });

  it('vouches for nothing when a session is unknown or none is named', async () => {
    const known = fresh('known');
    await send(wrapped({ [known]: 'bypassPermissions' }), known);
    expect(postLevelFor([])).toBeUndefined();
    expect(postLevelFor([undefined, null])).toBeUndefined();
    expect(postLevelFor([known, fresh('never-ran')])).toBeUndefined();
    const entry = fresh('entry');
    noteEntryLevel(entry, undefined);
    expect(entryLevelOf(entry)).toBeUndefined();
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
    const session = fresh('ana');
    const entry = fresh('e-ana');
    await send(wrapped({ [session]: 'acceptEdits' }), session);
    noteEntryLevel(entry, postLevelFor([session]));
    expect(ceilingForEntry(REGISTRY, { id: entry, authorId: 'ana' })).toEqual({
      permissionCeiling: ACCEPT_EDITS,
    });
  });

  it('holds an agent’s post whose level was not kept to the runtime default', () => {
    expect(ceilingForEntry(REGISTRY, { id: 'unkept', authorId: 'ana' })).toEqual({
      permissionCeiling: 'runtime-default',
    });
  });

  it('carries a stranger’s mark, not its hold, through an agent at Full autonomy to the next agent', async () => {
    // Ana's conversation is at Full autonomy. A stranger's message wakes it:
    // that turn runs at the default. Ana posts; Ben's turn carries the mark at
    // Ana's own level, gated rather than held (DOR-3390).
    const session = fresh('ana');
    const entry = fresh('e-ana');
    const runtime = wrapped({ [session]: 'bypassPermissions' });
    await send(runtime, session, ceilingForEntry(REGISTRY, { id: 'e0', authorId: 'stranger' }));
    noteEntryLevel(entry, postLevelFor([session]));
    // Ana's own level, and the mark her post carries on top of it (DOR-3141).
    expect(ceilingForEntry(REGISTRY, { id: entry, authorId: 'ana' })).toEqual({
      permissionCeiling: [FULL_OUTSIDER, FULL_OUTSIDER],
    });
  });
});

describe('the ceiling of a turn answering several messages', () => {
  it('holds every author’s bound at once, so a person writing last does not lift a stranger’s', () => {
    expect(
      ceilingForEntries(REGISTRY, [
        { id: 'e1', authorId: 'stranger' },
        { id: 'e2', authorId: 'dorian' },
      ])
    ).toEqual({ permissionCeiling: 'runtime-default' });
  });

  it('lists several bounds when more than one author is bounded', async () => {
    const session = fresh('ana');
    const entry = fresh('e-ana');
    await send(wrapped({ [session]: 'acceptEdits' }), session);
    noteEntryLevel(entry, postLevelFor([session]));
    expect(
      ceilingForEntries(REGISTRY, [
        { id: entry, authorId: 'ana' },
        { id: 'e2', authorId: 'stranger' },
      ])
    ).toEqual({ permissionCeiling: [ACCEPT_EDITS, 'runtime-default'] });
  });

  it('puts no bound on a burst only people on this machine wrote', () => {
    expect(ceilingForEntries(REGISTRY, [{ id: 'e1', authorId: 'dorian' }])).toEqual({});
  });
});

describe('a turn a continuation’s hold clamped (DOR-3203)', () => {
  afterEach(() => setContinuationHoldDb(undefined));

  /** A chat whose latest turn was held, read back by a new process (a restart). */
  function heldAcrossRestart(chat: string) {
    const db = createTestDb();
    setContinuationHoldDb(db);
    noteTurnHold(chat, true);
    setContinuationHoldDb(db);
    return db;
  }

  it('runs at the default, marks nothing it posts, and leaves the hold as it was', async () => {
    const chat = fresh('woken-after-restart');
    const entry = fresh('woken-post');
    const db = heldAcrossRestart(chat);
    const runtime = wrapped({ [chat]: 'bypassPermissions' });
    await send(runtime, chat, ceilingForContinuation(chat));
    expect(lastTurnLevelOf(chat)).toEqual(DEFAULT);
    noteEntryLevel(entry, postLevelFor([chat]));
    expect(entryLevelOf(entry)).toEqual(DEFAULT);
    expect(entryLevelOf(entry)?.outsider).toBeUndefined();
    // Still held: the next continuation holds too (DOR-3037).
    setContinuationHoldDb(db);
    expect(lastTurnHeld(chat)).toBe(true);
  });

  it('is unlike a stranger’s hold, which marks the turn and records it as held', async () => {
    const chat = fresh('stranger-held');
    const db = createTestDb();
    setContinuationHoldDb(db);
    noteTurnHold(chat, false);
    await send(wrapped({ [chat]: 'bypassPermissions' }), chat, {
      permissionCeiling: 'runtime-default',
    });
    // What it hands on is marked, at its own level without the hold (DOR-3390).
    expect(postLevelFor([chat])).toEqual(FULL_OUTSIDER);
    expect(lastTurnLevelOf(chat)).toEqual(DEFAULT_OUTSIDER);
    setContinuationHoldDb(db);
    expect(lastTurnHeld(chat)).toBe(true);
  });

  it('still marks what a chat a stranger reached posts', async () => {
    const chat = fresh('connector-chat');
    heldAcrossRestart(chat);
    noteTurnOrigin(chat, { kind: 'connector-event' });
    await send(wrapped({ [chat]: 'bypassPermissions' }), chat, ceilingForContinuation(chat));
    expect(postLevelFor([chat])).toMatchObject({ outsider: true });
  });
});
