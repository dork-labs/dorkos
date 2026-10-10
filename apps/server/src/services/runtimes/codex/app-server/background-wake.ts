/**
 * What a Codex background wake carries over from the turn that left the work
 * running, and the budget that keeps wakes from looping (spec
 * `codex-app-server-transport` §12). `codex-runtime.ts` starts the wake turns;
 * this decides what they inherit and when they stop.
 *
 * @module services/runtimes/codex/app-server/background-wake
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { BackgroundCompletion } from './background-work.js';

/**
 * Model turns background work may start in a row with no dispatched turn
 * between them. Each wake is the agent answering its own work; three in a row
 * with nobody's word in between is a loop, not progress, so the fourth
 * finish is shown and the chat waits for a person (spec §12).
 */
export const MAX_CONSECUTIVE_WAKES = 3;

/** What the person reads when the wake budget is spent. */
export const WAKE_BUDGET_SPENT_COPY =
  'Codex woke this chat three times in a row, so it waits for you now.';

/** The options a wake's turn inherits from the turn that left the work running. */
export interface CodexWakeContext {
  readonly opts: MessageOpts;
}

/**
 * The part of a dispatched turn's options a wake's turn may carry: who it runs
 * as, where, with which folders and account. Never the message's own id,
 * title, disposition or attached context, which belong to that message.
 *
 * **Never the permission mode, model, effort or fast mode.** Those are the
 * session's, and the person may change them after the starting turn: a
 * scheduled run at Full access must not make a wake run at Full access after
 * the person set Ask first. The wake reads the session's current values.
 *
 * A room turn returns `undefined`: its tools and identity are bound to the
 * room's dispatch (its turn id and author), which a wake cannot reproduce, so
 * its leftover work is shown and the room carries on on its own next turn —
 * which also keeps every wake inside the room's own turn limits.
 */
export function wakeContextOf(
  opts: MessageOpts | undefined,
  cwd: string
): CodexWakeContext | undefined {
  if (opts?.roomTurn !== undefined) return undefined;
  const carried = {
    cwd,
    ...(opts?.forAgent !== undefined ? { forAgent: opts.forAgent } : {}),
    ...(opts?.systemPromptAppend !== undefined
      ? { systemPromptAppend: opts.systemPromptAppend }
      : {}),
    ...(opts?.additionalDirectories !== undefined
      ? { additionalDirectories: opts.additionalDirectories }
      : {}),
    ...(opts?.accountHint !== undefined ? { accountHint: opts.accountHint } : {}),
    ...(opts?.unattended !== undefined ? { unattended: opts.unattended } : {}),
    ...(opts?.unattendedApprovals !== undefined
      ? { unattendedApprovals: opts.unattendedApprovals }
      : {}),
    // The bound travels with the work it bounds: a wake turn after background
    // work an outsider's turn started runs no looser than that turn did.
    ...(opts?.permissionCeiling !== undefined ? { permissionCeiling: opts.permissionCeiling } : {}),
  } as MessageOpts;
  return { opts: carried };
}

/**
 * The one context every waking completion shares, or `undefined` when any
 * lacks one or they came from turns run differently: then the finishes are
 * shown and no model turn starts, rather than one running as the wrong agent.
 */
export function sharedWakeContext(
  completions: readonly BackgroundCompletion[]
): CodexWakeContext | undefined {
  const contexts = completions.map(
    (completion) => completion.context as CodexWakeContext | undefined
  );
  const first = contexts[0];
  if (first === undefined) return undefined;
  const key = JSON.stringify(first.opts);
  return contexts.every((context) => context !== undefined && JSON.stringify(context.opts) === key)
    ? first
    : undefined;
}
