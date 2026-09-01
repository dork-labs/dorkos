/**
 * The cross-runtime chat suite: what a person is owed by the chat pane, asserted
 * the same way on every runtime.
 *
 * These cases exist because DorkOS's headline claim is that Claude Code, Codex
 * and OpenCode run side by side in one window, and until now nothing drove a real
 * turn through anything but claude-code. `--runtime opencode --provider openrouter`
 * makes the same six cases run against somebody else's model, on the
 * `real-provider` tier, for fractions of a cent.
 *
 * ## Structural oracles only, and not as a stylistic preference
 *
 * Nothing here reads the assistant's prose. Two independent reasons, either of
 * which would be enough:
 *
 * 1. **There is no determinism seam.** OpenCode's `session.promptAsync` body
 *    (`@opencode-ai/sdk@1.18.15`, `SessionPromptData`) carries `messageID`,
 *    `model`, `agent`, `noReply`, `system`, `tools` and `parts` — no
 *    temperature, no seed — and DorkOS sends only `{parts, model}`. A prose
 *    assertion against a cheap open-weight model has nothing holding it still.
 * 2. **A prose red points at the wrong thing.** `apps/e2e`'s chat spec asserts
 *    `toContainText('hello world')`, which is fine against a scripted test-mode
 *    runtime and would be an intermittent red here — and the red would be about
 *    the model, not about DorkOS. Ported as-is it would teach people to ignore
 *    this suite.
 *
 * So every oracle asks a question with a mechanical answer: did the turn
 * terminate exactly once, did a tool call open and close, was the permission
 * prompt answered, is the file on disk, did the cost arrive, is the model the one
 * we pinned, did a bad model fail out loud instead of hanging.
 *
 * ## Approvals are not optional here
 *
 * The OpenCode sidecar is spawned with a conservative ask-ruleset
 * (`OPENCODE_SIDECAR_CONFIG` → `{edit: 'ask', bash: 'ask', webfetch: 'ask'}`,
 * injected as `OPENCODE_CONFIG_CONTENT` on every spawn), so every tool-using turn
 * parks on a `permission.asked` that becomes an `approval_required` nobody would
 * otherwise answer. A case here without an {@link ApprovalPolicy} does not run a
 * weaker test; it dies on the turn timeout. The two approval cases turn that
 * constraint into the assertion.
 *
 * ## Quarantined on landing
 *
 * Every case here reports and none of them gate, per the promotion bar in
 * `packages/evals/README.md`: three runs that reach their oracles, all green,
 * before anything is promoted. The tier is brand new and the runtime under it has
 * never been driven this way before — a red on its first week would be far more
 * likely to be about the harness than about the product.
 *
 * @module evals/suite/chat
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvalCase, EvalSandbox } from '../types.js';
import { DEFAULT_OPENROUTER_MODEL } from '../types.js';
import { httpGetAssert } from '../oracles/api.js';
import { toolPermissionAnswered } from '../oracles/approvals.js';
import { fileExists, pathAbsent } from '../oracles/filesystem.js';
import {
  costReportedPositive,
  failedHonestly,
  modelReportedIs,
  toolLoopClosed,
  turnEndedExactlyOnce,
} from '../oracles/stream.js';

/**
 * A per-eval spend ceiling for every case here.
 *
 * A full six-case pass measured $0.0072 on OpenRouter's own meter (2026-09-01),
 * so five cents is roughly forty turns' worth: not a budget, a tripwire for a
 * loop. It is set per case as well as per run because the run cap only stops the
 * NEXT case, and a single runaway turn is the thing worth catching inside the one
 * that is running.
 */
const PER_CASE_CEILING_USD = 0.05;

/** The file a tool-loop case reads, and the sentence it is asked about. */
const READABLE_FILE = 'notes.txt';

/** The file the approval cases ask the agent to write. */
const WRITABLE_FILE = 'approved.txt';

/**
 * Seed one small, unambiguous file in the project directory, so the tool-loop
 * case has something real to read.
 *
 * Deliberately boring content: the oracle asks whether a tool loop opened and
 * closed, not whether the model understood the file, so anything the model might
 * be tempted to answer FROM MEMORY instead of reading would weaken the case.
 *
 * @param sandbox - The eval sandbox to seed.
 */
async function seedReadableFile(sandbox: EvalSandbox): Promise<void> {
  await writeFile(
    path.join(sandbox.projectCwd, READABLE_FILE),
    ['alpha', 'bravo', 'charlie'].join('\n') + '\n',
    'utf8'
  );
}

/**
 * The tools a read-shaped turn may use.
 *
 * An ALLOWLIST, and a deliberately wide one across runtimes: claude-code reaches
 * for `Read`/`Grep`/`Glob`, OpenCode for `read`/`grep`/`glob`/`list`, and either
 * may fall back to `bash`. All of those are correct answers to "look at this
 * file", and the oracle does not care which was chosen. Everything outside the
 * list is denied and recorded, so a turn that goes wandering is refused in
 * milliseconds rather than waved through.
 */
const READ_TOOLS = ['read', 'Read', 'grep', 'Grep', 'glob', 'Glob', 'list', 'LS', 'bash', 'Bash'];

/** The tools a write-shaped turn may use. */
const WRITE_TOOLS = ['write', 'Write', 'edit', 'Edit', 'bash', 'Bash'];

/**
 * `chat-turn-round-trip` — the whole point of a chat surface, in one turn: ask a
 * question, get exactly one turn, and have the platform be able to say what it
 * cost and what was said.
 *
 * Three oracles rather than three cases because they are three readings of ONE
 * turn, and splitting them would triple the spend to learn nothing extra. Each
 * still reports its own verdict and evidence, so a red names which reading failed.
 *
 * The history oracle reads `GET /api/sessions/:id/messages`, which on OpenCode is
 * served from the sidecar's own durable store rather than the EventLog fallback
 * (`supportsResume: true`, `logBackedHistory: true` — both paths exist, and this
 * asserts the one a person revisiting a session actually gets).
 */
export const chatTurnRoundTripCase: EvalCase = {
  id: 'chat-turn-round-trip',
  title: 'Chat round trip — one turn, one terminal, a real cost, and history to revisit',
  prompt: 'Reply with the single word: pong.',
  runtimeTier: 'real-provider',
  costClass: 'cheap',
  tags: ['chat'],
  quarantined: true,
  perEvalCeilingUsd: PER_CASE_CEILING_USD,
  oracles: [
    turnEndedExactlyOnce(),
    costReportedPositive(),
    httpGetAssert(
      (ctx) =>
        `/api/sessions/${encodeURIComponent(ctx.sessionId)}/messages?cwd=${encodeURIComponent(ctx.sandbox.projectCwd)}`,
      // `{ messages: [...] }`, not a bare array — measured against the live
      // route rather than assumed. A predicate that guessed the envelope would
      // have reported "history is empty" about a session whose history was
      // right there.
      {
        status: 200,
        body: (b) => ((b as { messages?: unknown }).messages as unknown[])?.length > 0,
      },
      'the finished turn is readable back as history'
    ),
  ],
};

/**
 * `chat-tool-loop` — the agent reaches for a tool, the tool runs, and the loop
 * closes on the same call id.
 *
 * The prompt names the file and asks for something only reading it can answer, so
 * a model that answers from thin air produces no tool call and the case reds. It
 * asks for a count rather than the contents because a count is unguessable and
 * still requires no assertion on the answer.
 */
export const chatToolLoopCase: EvalCase = {
  id: 'chat-tool-loop',
  title: 'Chat tool loop — a real tool call opens and the same call closes',
  prompt: `Read the file ${READABLE_FILE} in the current directory and tell me how many lines it has.`,
  runtimeTier: 'real-provider',
  costClass: 'cheap',
  tags: ['chat'],
  quarantined: true,
  perEvalCeilingUsd: PER_CASE_CEILING_USD,
  seed: seedReadableFile,
  approvalPolicy: { allowTools: READ_TOOLS },
  oracles: [toolLoopClosed(), turnEndedExactlyOnce()],
};

/**
 * `chat-approval-allows-the-write` — a person says yes and the thing happens.
 *
 * The filesystem is the oracle, which is what keeps this honest: the agent's own
 * report that it wrote the file is exactly the claim under test. Paired with the
 * approval-log oracle so a runtime that never asked at all cannot pass by simply
 * writing the file unprompted — that would be the permission surface failing
 * open, and it must not read as green.
 */
export const chatApprovalAllowsWriteCase: EvalCase = {
  id: 'chat-approval-allows-the-write',
  title: 'Chat approval — an allowed tool prompt lets the write through',
  prompt: `Create a file called ${WRITABLE_FILE} in the current directory containing the word ready.`,
  runtimeTier: 'real-provider',
  costClass: 'cheap',
  tags: ['chat'],
  quarantined: true,
  perEvalCeilingUsd: PER_CASE_CEILING_USD,
  approvalPolicy: { allowTools: WRITE_TOOLS },
  oracles: [
    toolPermissionAnswered('allow', 'the write was asked about, and allowed'),
    fileExists((s) => path.join(s.projectCwd, WRITABLE_FILE), 'the approved file was written'),
    turnEndedExactlyOnce(),
  ],
};

/**
 * `chat-approval-refuses-the-write` — a person says no and the thing does not
 * happen.
 *
 * The mirror image, and the half that a permission surface can only pass by
 * actually working: the policy's allowlist is EMPTY, so every prompt is answered
 * `deny`. `pathAbsent` then proves nothing was written, and the approval-log
 * oracle proves the absence was a refusal rather than a turn that never tried.
 *
 * The turn must still end. A denied tool that hangs the turn is a different (and
 * worse) bug than a denied tool that fails it, and `turnEndedExactlyOnce` is what
 * tells them apart.
 */
export const chatApprovalRefusesWriteCase: EvalCase = {
  id: 'chat-approval-refuses-the-write',
  title: 'Chat approval — a refused tool prompt keeps the write from happening',
  prompt: `Create a file called ${WRITABLE_FILE} in the current directory containing the word ready.`,
  runtimeTier: 'real-provider',
  costClass: 'cheap',
  tags: ['chat'],
  quarantined: true,
  perEvalCeilingUsd: PER_CASE_CEILING_USD,
  approvalPolicy: { allowTools: [] },
  oracles: [
    toolPermissionAnswered('deny', 'the write was asked about, and refused'),
    pathAbsent((s) => path.join(s.projectCwd, WRITABLE_FILE), 'the refused file was never written'),
    turnEndedExactlyOnce(),
  ],
};

/**
 * `chat-model-is-the-pinned-one` — the turn ran on the model the run said it
 * would.
 *
 * OpenCode-only, because the property is about OpenCode's model addressing:
 * DorkOS stores one `provider/model` string and `parseModelSelection`
 * (`opencode/turn-input.ts`) splits it on the FIRST `/`, so
 * `openrouter/qwen/qwen3.7-flash` means `{providerID: 'openrouter', modelID:
 * 'qwen/qwen3.7-flash'}` and the two obvious mis-spellings mean nothing at all.
 * Nothing in the repo pinned that convention before this case; reading the model
 * back off the durable stream is what turns it into a fact.
 */
export const chatModelPinnedCase: EvalCase = {
  id: 'chat-model-is-the-pinned-one',
  title: 'Chat model pin — the turn reports the OpenRouter model the run pinned',
  prompt: 'Reply with the single word: pong.',
  runtimeTier: 'real-provider',
  runtime: 'opencode',
  costClass: 'cheap',
  tags: ['chat'],
  quarantined: true,
  perEvalCeilingUsd: PER_CASE_CEILING_USD,
  oracles: [modelReportedIs(DEFAULT_OPENROUTER_MODEL), turnEndedExactlyOnce()],
};

/**
 * A model id that cannot resolve, in the right SHAPE.
 *
 * Two segments after the provider, exactly like the real pin, so the failure this
 * case measures is "the provider does not have this model" rather than "DorkOS
 * could not parse the string" — the second would be a test of
 * `parseModelSelection` wearing the costume of a test about honest failure.
 */
const UNREACHABLE_MODEL = 'openrouter/dorkos-evals/model-that-does-not-exist';

/**
 * `chat-bad-model-fails-honestly` — an unreachable model produces a typed error
 * before the terminal, not a spinner.
 *
 * This is the case a person actually meets: they pick a model that has been
 * retired, or fat-finger an id, and what happens next is the whole of their
 * experience. A hang is the worst available outcome and costs the most (the turn
 * runs to the harness's 90-second guard), so it is worth one deliberately failing
 * turn per run to know it does not happen.
 *
 * Effectively free: the provider refuses before any tokens are generated.
 */
export const chatBadModelFailsHonestlyCase: EvalCase = {
  id: 'chat-bad-model-fails-honestly',
  title: 'Chat failure honesty — an unreachable model errors out loud instead of hanging',
  prompt: 'Reply with the single word: pong.',
  runtimeTier: 'real-provider',
  runtime: 'opencode',
  model: UNREACHABLE_MODEL,
  costClass: 'cheap',
  tags: ['chat'],
  quarantined: true,
  perEvalCeilingUsd: PER_CASE_CEILING_USD,
  oracles: [failedHonestly()],
};

// One thing this case does NOT prove, said plainly: `failedHonestly` passes on
// ANY typed error, so a run whose provider was unreachable for some other reason
// (a revoked key, a network fault) would also make it green. That is acceptable
// because it never runs alone — the other five cases in the suite reach the
// model, so a green here beside five reds means "everything failed", not "bad
// models fail well". Reading it against its siblings is the check.

/** Every case in the cross-runtime chat suite (`--suite chat`). */
export const chatCases: EvalCase[] = [
  chatTurnRoundTripCase,
  chatToolLoopCase,
  chatApprovalAllowsWriteCase,
  chatApprovalRefusesWriteCase,
  chatModelPinnedCase,
  chatBadModelFailsHonestlyCase,
];
