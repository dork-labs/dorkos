/**
 * A reader that may see a stranger's line first-hand is held, even when another agent's post woke
 * it (DOR-3390, Security's M-B on #3242). Outside the owner's own circle (a bridged room, or a
 * stranger's line in the reader's view), a post carrying an outsider's mark holds its reader to
 * the runtime default, as it did before #3242. Inside the circle the mark rides on without the
 * hold. Security's proof from the review, turned around to pin the fix.
 *
 * Every case uses the real seam that records turn levels, the real room ceilings and the real
 * held-turn hook.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  createHeldTurnHook,
  HELD_TURN_ASK_REASON,
} from '../../../runtimes/claude-code/tool-gate/held-turn-hook.js';
import { noteEntryLevel, postLevelFor, recordTurnLevels } from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { ceilingForEntry } from '../../../rooms/limits/turn-ceiling.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';
import { resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes;
const RECORDS: Record<string, { kind: 'human' | 'agent'; naturalKey: string }> = {
  pm: { kind: 'agent', naturalKey: '/agents/pm' },
  code: { kind: 'agent', naturalKey: '/agents/code' },
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
const FOLDERS = { cwd: '/agents/code', roots: ['/agents/code'] };

let counter = 0;
const fresh = (name: string) => `${name}-first-hand-${(counter += 1)}`;

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

/** What the held-turn hook answers for one call in a turn sent with these options. */
async function hookSays(opts: MessageOpts | undefined, toolName: string, input = {}) {
  const session = {
    permissionMode: runsAt(opts) as 'bypassPermissions',
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

/** PM answers a stranger directly (held), then posts; returns the post's id. */
async function strangerHeldPost(runtime: AgentRuntime): Promise<string> {
  const pm = fresh('pm');
  await run(runtime, pm, { permissionCeiling: 'runtime-default' });
  const id = fresh('post');
  noteEntryLevel(id, postLevelFor([pm]), ROOM);
  return id;
}

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
});
afterEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
});

describe('a reader that may see the stranger first-hand', () => {
  it('outside the own circle, is held by a stranger-held poster’s post, and Edit and WebFetch ask', async () => {
    const { runtime, sent } = seam();
    const code = fresh('code');
    const post = await strangerHeldPost(runtime);
    const opts = ceilingForEntry(AUTHORS, { id: post, authorId: 'pm' }, false, ROOM, {
      ownCircle: false,
    });
    expect(JSON.stringify(opts.permissionCeiling)).toContain('runtime-default');
    await run(runtime, code, { ...opts, roomTurn: { outsiderInView: true } } as MessageOpts);
    expect(runsAt(sent.get(code))).toBe('default');
    expect(await hookSays(sent.get(code), 'Edit', { file_path: '/agents/code/a.md' })).toBe(
      HELD_TURN_ASK_REASON
    );
    expect(await hookSays(sent.get(code), 'WebFetch', { url: 'https://x.test/?q=secret' })).toBe(
      HELD_TURN_ASK_REASON
    );
  });

  it('inside the own circle, runs at its own level, marked, and at Full nothing asks', async () => {
    const { runtime, sent } = seam();
    const code = fresh('code');
    const post = await strangerHeldPost(runtime);
    const opts = ceilingForEntry(AUTHORS, { id: post, authorId: 'pm' }, false, ROOM, {
      ownCircle: true,
    });
    expect(JSON.stringify(opts.permissionCeiling)).not.toContain('runtime-default');
    await run(runtime, code, opts);
    expect(runsAt(sent.get(code))).toBe('bypassPermissions');
    expect(await hookSays(sent.get(code), 'Edit', { file_path: '/agents/code/a.md' })).toBe('runs');
    // A chat set to Full never asks (DOR-3394). Until then its shell asked here; below Full it
    // still does (`held-turn-hook.test.ts`, `carried-turn-writes.test.ts`).
    expect(await hookSays(sent.get(code), 'Bash', { command: 'touch x' })).toBe('runs');
  });
});
