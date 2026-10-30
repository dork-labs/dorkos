/**
 * How one outsider mark spread through #dorkos on 2026-10-28, and what it costs now (DOR-3390).
 *
 * The real chain, from `dork.db` and the audit log: the Dorian Desk mini app forwarded a comment
 * into the PM's chat as an untrusted app message, so that turn was held and marked (rightly). The
 * PM's chat posted into #dorkos; every agent that answered it was held, recorded a held level and
 * a sticky mark, and handed both on in its own posts. 144 of 189 agent posts since were marked,
 * and every one held its readers, so Dorian got a card for nearly everything.
 *
 * Security's design (2026-10-29): the mark stays sticky and transitive, but it gates the actions
 * that matter instead of capping the turn. A turn our own agent's marked post or message starts
 * runs at its own level, still marked; until its shell runs sandboxed, Bash asks. A turn a
 * stranger's words start directly is held as before, and so is a spin-off it starts.
 *
 * Every case uses the real seam that records turn levels, the real room ceilings in the owner's
 * own circle, and the real held-turn hook.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  CARRIED_SHELL_ASK_REASON,
  createHeldTurnHook,
  HELD_TURN_ASK_REASON,
} from '../../../runtimes/claude-code/tool-gate/held-turn-hook.js';
import {
  lastTurnLevelOf,
  markedBoundOf,
  noteEntryLevel,
  postLevelFor,
  recordTurnLevels,
} from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { ceilingForEntry } from '../../../rooms/limits/turn-ceiling.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';
import {
  parseCeiling,
  senderBound,
  senderCeilingJson,
} from '../../../session/chat-messages/chat-message-ceiling.js';
import { resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes;
const RECORDS: Record<string, { kind: 'human' | 'agent'; naturalKey: string }> = {
  pm: { kind: 'agent', naturalKey: '/agents/pm' },
  sec: { kind: 'agent', naturalKey: '/agents/sec' },
  code: { kind: 'agent', naturalKey: '/agents/code' },
  owner: { kind: 'human', naturalKey: 'operator' },
};
const AUTHORS = {
  getMany: (ids: readonly string[]) =>
    new Map(
      ids
        .map((id) => [id, RECORDS[id]] as const)
        .filter((pair): pair is readonly [string, (typeof RECORDS)[string]] => !!pair[1])
    ),
} as unknown as AuthorRegistry;

const ROOM = 'dorkos';
const OWN_CIRCLE = { ownCircle: true };
const FOLDERS = { cwd: '/agents/code', roots: ['/agents/code'] };

let counter = 0;
const fresh = (name: string) => `${name}-spread-${(counter += 1)}`;

/** A runtime wrapped the way the registry wraps it; every chat is stored at Full autonomy. */
function seam(): { runtime: AgentRuntime; sent: Map<string, MessageOpts | undefined> } {
  const sent = new Map<string, MessageOpts | undefined>();
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(sessionId: string, _content: string, opts?: MessageOpts) {
      sent.set(sessionId, opts);
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return { runtime: recordTurnLevels(runtime, () => 'bypassPermissions'), sent };
}

async function run(runtime: AgentRuntime, sessionId: string, opts?: MessageOpts) {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** The mode a Full autonomy chat runs a turn at under the ceiling it was sent with. */
function runsAt(opts: MessageOpts | undefined): string {
  return opts?.permissionCeiling === undefined
    ? 'bypassPermissions'
    : clampModeToCeiling(MODES, 'bypassPermissions', opts.permissionCeiling);
}

/** A chat writes a post into the room, kept with the level its chat hands on. */
function post(sessionId: string): string {
  const id = fresh('post');
  noteEntryLevel(id, postLevelFor([sessionId]), ROOM);
  return id;
}

/** The ceiling a turn answering this post runs under, in the owner's own circle. */
function answering(entryId: string, authorId: string): MessageOpts {
  return ceilingForEntry(AUTHORS, { id: entryId, authorId }, false, ROOM, OWN_CIRCLE);
}

/**
 * What the held-turn hook answers for one call in a turn sent with these options, in a chat set to
 * `permissionMode`. A chat set to Full asks nobody anything (DOR-3394), so the asks below are
 * pinned at Accept edits; each was pinned at Full until then.
 */
async function hookSays(
  opts: MessageOpts | undefined,
  toolName: string,
  input = {},
  permissionMode: 'bypassPermissions' | 'acceptEdits' = 'bypassPermissions'
) {
  const session = {
    permissionMode,
    ...(opts?.permissionCeiling !== undefined
      ? { turnPermissionCeiling: opts.permissionCeiling }
      : {}),
  };
  const hook = createHeldTurnHook(session, async () => ({}), { debug() {}, info() {} }, FOLDERS);
  const out = (await hook(
    {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '/t',
      cwd: FOLDERS.cwd,
      tool_name: toolName,
      tool_input: input,
      tool_use_id: 't',
    } as never,
    't',
    { signal: new AbortController().signal }
  )) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
  return out.hookSpecificOutput?.permissionDecisionReason ?? 'runs';
}

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
});

afterEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
});

describe('an outsider mark in a team room (DOR-3390)', () => {
  it('stays on every turn down the chain, and caps none of them', async () => {
    const { runtime, sent } = seam();
    const pm = fresh('pm');
    const sec = fresh('sec');
    const code = fresh('code');

    // 1. The PM's chat reads a mini app's forward: a stranger's hold, so it is held.
    await run(runtime, pm, { permissionCeiling: 'runtime-default' });
    expect(runsAt(sent.get(pm))).toBe('default');

    // 2. Security answers the PM's post: marked, at its own level.
    await run(runtime, sec, answering(post(pm), 'pm'));
    expect(runsAt(sent.get(sec))).toBe('bypassPermissions');
    expect(lastTurnLevelOf(sec)?.outsider).toBe(true);

    // 3. Security's next turn answers only the owner; its post still carries the mark on.
    await run(runtime, sec, answering(fresh('owner-line'), 'owner'));
    await run(runtime, code, answering(post(sec), 'sec'));
    expect(runsAt(sent.get(code))).toBe('bypassPermissions');
    expect(lastTurnLevelOf(code)?.outsider).toBe(true);
  });

  it('lets a marked turn read, edit its own folder and post, and asks about its shell', async () => {
    const { runtime, sent } = seam();
    const pm = fresh('pm');
    const code = fresh('code');
    await run(runtime, pm, { permissionCeiling: 'runtime-default' });
    await run(runtime, code, answering(post(pm), 'pm'));
    const opts = sent.get(code);
    expect(await hookSays(opts, 'Read', { file_path: '/agents/code/a.md' })).toBe('runs');
    expect(await hookSays(opts, 'Edit', { file_path: '/agents/code/a.md' })).toBe('runs');
    expect(await hookSays(opts, 'mcp__dorkos__post_to_room', { roomId: ROOM, text: 'x' })).toBe(
      'runs'
    );
    expect(await hookSays(opts, 'Bash', { command: 'python3 -c 1' }, 'acceptEdits')).toBe(
      CARRIED_SHELL_ASK_REASON
    );
    // In a chat set to Full its shell runs too (DOR-3394).
    expect(await hookSays(opts, 'Bash', { command: 'python3 -c 1' })).toBe('runs');
  });

  it('still holds a stranger’s own turn entirely, and a spin-off it starts', async () => {
    const { runtime, sent } = seam();
    const pm = fresh('pm');
    await run(runtime, pm, { permissionCeiling: 'runtime-default' });
    const write = { file_path: '/agents/code/x.ts' };
    expect(await hookSays(sent.get(pm), 'Write', write, 'acceptEdits')).toBe(HELD_TURN_ASK_REASON);
    // A chat set to Full is not asked even here (DOR-3394); its launch is still held below.
    expect(await hookSays(sent.get(pm), 'Write', write)).toBe('runs');
    const bound = markedBoundOf(pm, '/agents/pm');
    expect(bound).toContain('runtime-default');
    const child = fresh('child');
    await run(runtime, child, { permissionCeiling: bound! });
    expect(runsAt(sent.get(child))).toBe('default');
  });

  it('carries the mark onward through a chat_send from a marked turn', async () => {
    const { runtime, sent } = seam();
    const pm = fresh('pm');
    const sec = fresh('sec');
    const cloud = fresh('cloud');
    await run(runtime, pm, { permissionCeiling: 'runtime-default' });
    await run(runtime, sec, answering(post(pm), 'pm'));
    const stored = await senderCeilingJson(
      { turnLevelOf: (id) => (id === sec ? lastTurnLevelOf(sec) : undefined) },
      { sessionId: sec, agentPath: '/agents/sec' }
    );
    await run(runtime, cloud, { permissionCeiling: parseCeiling(stored) });
    expect(runsAt(sent.get(cloud))).toBe('bypassPermissions');
    expect(lastTurnLevelOf(cloud)?.outsider).toBe(true);
    const gh = { command: 'gh pr list' };
    expect(await hookSays(sent.get(cloud), 'Bash', gh, 'acceptEdits')).toBe(
      CARRIED_SHELL_ASK_REASON
    );
    expect(await hookSays(sent.get(cloud), 'Bash', gh)).toBe('runs');
  });
});

describe('the carried mark, stored on a chat message (fails closed)', () => {
  it('is kept by name, and reads back as the mark', async () => {
    const pm = fresh('pm');
    const { runtime } = seam();
    await run(runtime, pm, { permissionCeiling: 'runtime-default' });
    const sec = fresh('sec');
    await run(runtime, sec, answering(post(pm), 'pm'));
    // In memory the mark rides as the loosest level, marked...
    const bound = await senderBound(
      lastTurnLevelOf(sec),
      { sessionId: sec, agentPath: '/agents/sec' },
      undefined
    );
    expect(bound).toContainEqual({ asks: 'never', reach: 'everything', outsider: true });
    // ...and the row keeps it only by name, which an older reader takes as the runtime default.
    const stored = await senderCeilingJson(
      { turnLevelOf: () => lastTurnLevelOf(sec) },
      { sessionId: sec, agentPath: '/agents/sec' }
    );
    expect(stored).toContain('{"bound":"carried","marks":{"outsider":true}}');
    expect(stored).not.toContain('"everything"');
  });

  it('reads anything it does not know as the runtime default, never as Full', () => {
    expect(parseCeiling('{"bound":"carried","marks":{"outsider":true}}')).toEqual({
      asks: 'never',
      reach: 'everything',
      outsider: true,
    });
    // The loosest level written out bare is never how the mark is stored: unknown.
    expect(parseCeiling('{"asks":"never","reach":"everything","outsider":true}')).toBe(
      'runtime-default'
    );
    expect(parseCeiling('{"bound":"carried"}')).toBe('runtime-default');
    expect(parseCeiling('{"bound":"something-new","marks":{"outsider":true}}')).toBe(
      'runtime-default'
    );
    expect(parseCeiling('"carried"')).toBe('runtime-default');
  });
});
