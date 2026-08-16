/**
 * The message dispatcher is the ONLY place a person-initiated turn is started
 * (spec `persistent-session-runtime` §3.4, acceptance criterion 5).
 *
 * ## Why a grep, and why this is a test rather than a claim
 *
 * The dispatcher's guarantees — one decision about whether a session is free,
 * one queue, one gate on an open permission ask — are only true for callers that
 * go through it. A caller that reaches `runtime.sendMessage` on its own keeps
 * the race the dispatcher exists to remove, and it does so silently: nothing
 * fails, nothing logs, the session just occasionally gets two writers. That is
 * exactly the class of regression a review cannot catch by reading a diff,
 * because the offending line looks like every other line that was there before.
 *
 * So the audit is executable. It has the same shape as the other guard in this
 * repo that protects a rule with no behavior left to assert against
 * (`__tests__/no-auto-approve-env-var.test.ts`): `git grep` over the working
 * tree, tracked and untracked, with an explicit allow-list every entry of which
 * carries its reason.
 *
 * ## Scope
 *
 * `apps/server/src` — where every cockpit, room, task, embedded and mesh
 * trigger lives. `packages/relay` is deliberately outside it: relay's adapters
 * drive agent-to-agent sessions of their own through `RuntimeAdapter`
 * (ADR-0075's per-agentId chain), they cannot import from `apps/server`, and no
 * person is typing into them. Widening this guard to cover them would be
 * asserting a rule that was never made.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file rather than from the cwd. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/** The tree every person-initiated turn is started from. */
const SCOPE = 'apps/server/src';

/**
 * Files allowed to reach a runtime's turn-starting methods, each with the
 * reason it is not an ingress.
 *
 * Every entry here is a hole, so each one has to be justified rather than
 * merely listed. A new entry needs the same standard: it is not a place a
 * person's message enters the system.
 */
const ALLOWED = new Map<string, string>([
  [
    'apps/server/src/services/session/message-dispatcher.ts',
    'The single ingress itself — this is the one place the calls belong.',
  ],
  [
    'apps/server/src/services/session/trigger-turn.ts',
    'The dispatcher’s launcher. It never resolves a runtime; it calls the narrow ' +
      'port the dispatcher hands it (`deps.sendMessage`), which is the same thing ' +
      'as being called BY the dispatcher.',
  ],
  [
    'apps/server/src/services/session/trigger-command-intent.ts',
    'The command-intent half of the same launcher, on the same terms.',
  ],
  [
    'apps/server/src/services/observability/trace-runtime.ts',
    'A decorator around an already-resolved runtime. It starts nothing; it wraps ' +
      'the generator the dispatcher asked for so the span covers the real turn.',
  ],
  [
    'apps/server/src/services/tasks/task-scheduler-service.ts',
    'A scheduled run is not a person-initiated turn and does not contend for a ' +
      'session: it mints a FRESH session per run (`sessionId = run.id`), consumes ' +
      'the stream in-band for its output summary, and races it against a cancel ' +
      'signal. There is no projector, no queue and no second writer to serialize ' +
      'against. Spec §3.4 names `tasks/run-stream.ts` in the caller list; that ' +
      'module turned out to be the abort-aware CONSUMER of an already-started ' +
      'stream, not a trigger, so the real call site is this one and it is out of ' +
      'the queue’s scope by construction.',
  ],
]);

/**
 * The runtime methods that START or STEER work; anything else is a read.
 *
 * `deliverIntoTurn` joins them (task 4.1): a steer and a stage are both WRITES
 * into a live turn, authorized identically to `sendMessage`, so they must reach
 * the runtime only through the dispatcher's two gates — `deliverSteer` for a
 * steer, `deliverStage` for a stage — never around them.
 */
const TURN_STARTERS = ['.sendMessage(', '.executeCommandIntent(', '.deliverIntoTurn('];

/**
 * Files under `SCOPE` whose working-tree contents contain `needle`.
 *
 * `--untracked` so an uncommitted new file is visible too; gitignored trees
 * (`dist/`, `node_modules/`) stay invisible without a skip list that could rot.
 * A `git` failure THROWS rather than reporting "nothing found": a guard that
 * cannot look must not pass.
 *
 * @param needle - The fixed string to search for.
 */
function filesCalling(needle: string): string[] {
  try {
    const stdout = execFileSync(
      'git',
      [
        'grep',
        '--untracked',
        '--files-with-matches',
        '-F',
        needle,
        '--',
        SCOPE,
        // Tests may drive a runtime directly; they are not production callers.
        ':(exclude)apps/server/src/**/__tests__/**',
        ':(exclude)apps/server/src/**/*.test.ts',
        // An adapter IMPLEMENTS these methods, and delegates between its own
        // internals. Confining the SDK to that tree is Hard Rule 2's job.
        ':(exclude)apps/server/src/services/runtimes/**',
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    return stdout.split('\n').filter((line) => line !== '');
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    // 1 is `git grep`'s "no lines matched", which is the passing case.
    if (status === 1) return [];
    throw err;
  }
}

describe('every person-initiated turn goes through the message dispatcher', () => {
  it.each(TURN_STARTERS)('nothing outside the dispatcher calls %s', (needle) => {
    const offenders = filesCalling(needle).filter((file) => !ALLOWED.has(file));

    expect(
      offenders,
      `These modules call ${needle} without going through the message dispatcher, so ` +
        `they keep the race it exists to remove: they can decide a session is free ` +
        `while another caller is deciding the same thing, they bypass the durable ` +
        `queue, and they can fire into an open permission ask. Route them through ` +
        `dispatchMessage / dispatchCommandIntent, or — if the call genuinely is not ` +
        `an ingress — add it to ALLOWED with the reason why.`
    ).toEqual([]);
  });

  it('the guard actually reaches the dispatcher, so a passing run means something', () => {
    // A grep that matched nothing anywhere would pass this suite while asserting
    // nothing at all. The dispatcher itself must be found, every time.
    for (const needle of TURN_STARTERS) {
      expect(filesCalling(needle)).toContain(
        'apps/server/src/services/session/message-dispatcher.ts'
      );
    }
  });
});
