/**
 * Every automatic continuation carries the chat's stored marks (DOR-3061, `chat-marks.ts`).
 *
 * A turn that picks a chat up on its own, with no new words from anyone (an approval's answer, an
 * automatic resume or handoff, a nudge after a sign-in, a wake after a restart), runs on the
 * latest turn's words. If that turn was marked (a Wi-Fi sign-in, a stranger, a teammate), the
 * continuation must carry the marks too, or it runs at the agent's own level on marked words.
 *
 * This census fails on:
 *
 * - a file that starts a turn (a dispatch, a trigger, a command intent such as a compaction, a
 *   direct `sendMessage`) that nobody has classified below;
 * - a continuation that does not read `continuationCeiling`;
 * - a classified file that no longer starts a turn (the entry is stale; remove it).
 *
 * If this fails on a new file, decide what it is. A turn nobody newly asked for is a
 * continuation and spreads `...continuationCeiling(sessionId)` into its dispatch; anything
 * else names why its turn already carries the right marks. Do not loosen the census.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** A call that starts a turn: a dispatch, a trigger, a command intent, or a runtime's send. */
const TURN_START =
  /(?:^|[^\w])(?:dispatchMessage|dispatchSessionMessage|triggerTurn|dispatchCommandIntent|executeCommandIntent)\(|\.sendMessage\(/;

/** How a file that starts a turn relates to the marks of the chat it continues. */
type Kind =
  { kind: 'continuation' } | { kind: 'new-words'; why: string } | { kind: 'plumbing'; why: string };

const CONTINUATION: Kind = { kind: 'continuation' };

/** Every file that starts a turn, classified. */
const CLASSIFIED: Record<string, Kind> = {
  'services/core/approvals/approval-verdict-delivery.ts': CONTINUATION,
  'services/mesh/mcp-signin-resume.ts': CONTINUATION,
  'services/session/fleet/carry-over.ts': CONTINUATION,
  'services/session/fleet/resume-service.ts': CONTINUATION,
  'services/session/runtime-turns/wake-cut-short-work.ts': CONTINUATION,
  // A compaction, a person's `/compact` or an agent's, is never new words.
  'routes/session-command-intent-handler.ts': CONTINUATION,
  'services/session/agent-compaction/agent-compaction-service.ts': CONTINUATION,

  'routes/sessions.ts': { kind: 'new-words', why: 'a person’s own message' },
  'routes/session-ui-action-handler.ts': { kind: 'new-words', why: 'a person’s own widget action' },
  'services/session/fleet/continue-service.ts': {
    kind: 'new-words',
    why: 'a person pressed continue in their own chat',
  },
  'services/extensions/start-work.ts': {
    kind: 'new-words',
    why: 'a person started the work from an app’s page',
  },
  'services/extensions/agent-send/agent-send.ts': {
    kind: 'new-words',
    why: 'an app’s message, which carries the outsider mark (DOR-3036)',
  },
  'services/core/session-relay/relay-request-server.ts': {
    kind: 'new-words',
    why: 'a relayed message, held to the runtime default (`RELAY_TURN_CEILING`)',
  },
  'services/heartbeats/beat-launch.ts': {
    kind: 'new-words',
    why: 'a beat, which carries the marks of whatever it read (DOR-3036)',
  },
  'services/rooms/room-turn-runner.ts': {
    kind: 'new-words',
    why: 'a room post, held by `ceilingForEntry` to the marks of the post it answers',
  },
  'services/runtimes/claude-code/mcp-tools/session-tools.ts': {
    kind: 'new-words',
    why: '`session_start`, which sends its caller’s `markedBoundOf`',
  },
  'services/tasks/task-scheduler-service.ts': {
    kind: 'new-words',
    why: 'a schedule’s run, which a marked turn parks until a person approves it (DOR-3036)',
  },

  'services/session/launch/launch-session.ts': {
    kind: 'plumbing',
    why: 'the session dispatcher itself',
  },
  'services/session/message-dispatcher.ts': { kind: 'plumbing', why: 'the dispatcher itself' },
  'services/session/message-dispatcher/launch.ts': {
    kind: 'plumbing',
    why: 'the dispatcher’s launch step',
  },
  'services/session/trigger-turn.ts': { kind: 'plumbing', why: 'the one turn trigger' },
  'services/session/trigger-command-intent.ts': {
    kind: 'plumbing',
    why: 'the one command-intent trigger',
  },
  'services/runtimes/codex/codex-runtime.ts': { kind: 'plumbing', why: 'a runtime itself' },
  'services/runtimes/doe/doe-runtime.ts': { kind: 'plumbing', why: 'a runtime itself' },
  'services/runtimes/opencode/opencode-runtime.ts': { kind: 'plumbing', why: 'a runtime itself' },
  'services/runtimes/test-mode/test-mode-runtime.ts': { kind: 'plumbing', why: 'a runtime itself' },
  'services/audit/record-tool-use.ts': { kind: 'plumbing', why: 'a runtime decorator' },
  'services/core/keep-awake/hold-during-turn.ts': { kind: 'plumbing', why: 'a runtime decorator' },
  'services/mesh/pause/hold-paused-turns.ts': { kind: 'plumbing', why: 'a runtime decorator' },
  'services/observability/runtime-signin-watch.ts': {
    kind: 'plumbing',
    why: 'a runtime decorator',
  },
  'services/observability/trace-runtime.ts': { kind: 'plumbing', why: 'a runtime decorator' },
  'services/runtimes/claude-code/claude-code-runtime.ts': {
    kind: 'plumbing',
    why: 'the runtime’s own internals',
  },
  'services/runtimes/claude-code/messaging/message-sender.ts': {
    kind: 'plumbing',
    why: 'the runtime’s own internals',
  },
};

/** Every non-test source file under `apps/server/src` that starts a turn. */
function turnStarters(): string[] {
  let out: string;
  try {
    out = execFileSync(
      'git',
      [
        'grep',
        '--untracked',
        '-lE',
        '(dispatchMessage|dispatchSessionMessage|triggerTurn|dispatchCommandIntent|executeCommandIntent)\\(|\\.sendMessage\\(',
        '--',
        '.',
        ':!**/__tests__/**',
      ],
      { cwd: SERVER_SRC, encoding: 'utf8' }
    );
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((file) => TURN_START.test(readFileSync(path.join(SERVER_SRC, file), 'utf8')))
    .sort();
}

describe('every turn that picks a chat up on its own carries its stored marks', () => {
  const starters = turnStarters();

  it('finds the turn starters (the census is reading the tree)', () => {
    expect(starters).toContain('routes/sessions.ts');
    expect(starters.length).toBeGreaterThan(10);
  });

  it('classifies every file that starts a turn', () => {
    expect(starters.filter((file) => !(file in CLASSIFIED))).toEqual([]);
  });

  it('has no stale entries', () => {
    expect(Object.keys(CLASSIFIED).filter((file) => !starters.includes(file))).toEqual([]);
  });

  it('reads the stored marks in every continuation', () => {
    const missing = Object.entries(CLASSIFIED)
      .filter(([, entry]) => entry.kind === 'continuation')
      .map(([file]) => file)
      .filter(
        (file) =>
          !/\.\.\.continuationCeiling\(/.test(readFileSync(path.join(SERVER_SRC, file), 'utf8'))
      );
    expect(missing).toEqual([]);
  });
});
