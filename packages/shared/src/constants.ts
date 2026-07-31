/** Default port for the DorkOS server. */
export const DEFAULT_PORT = 4242;

/**
 * SDK-internal tool names used by the Claude Agent SDK.
 * These are used for identifying special tool behaviours during transcript parsing.
 */
export const SDK_TOOL_NAMES = {
  /** Interactive question-and-answer tool for human input. */
  ASK_USER_QUESTION: 'AskUserQuestion',
  /** Skill expansion tool — injects a slash command prompt. */
  SKILL: 'Skill',
} as const;

/**
 * The width one slot of the composer's status line is priced at, in characters.
 *
 * The line's width budget counts slots, and a count only holds while every slot is
 * about one size. Below the line's widest density tier every value is cut to this
 * bound with an ellipsis; at the widest tier only the model item is, so a longer
 * value there spends more width than the budget charged for it (DOR-461).
 *
 * Lives here rather than in the client because it is a **contract with runtime
 * authors**, not a private UI detail: the static model catalogs DorkOS writes
 * (`CODEX_MODELS`) are held to it by the server's own tests. Third-party strings a
 * runtime merely relays — a provider's model display name from OpenCode's catalog —
 * are bounded on the way out instead of rejected, which is what this number is for.
 * Not everything DorkOS writes fits it: shipped permission-mode labels reach 18
 * characters (`'Bypass permissions'`), so this is a price rather than a guarantee.
 *
 * 13 is the width of the longest name in the two places that are asserted
 * (`GPT-5.3 Codex` in `CODEX_MODELS`, `Claude Code` in the client's runtime
 * descriptors). Deliberately counted in characters, not pixels: the composer's
 * `text-xs` is 1.25× larger below 768px and scales again with `--user-font-scale`,
 * so a pixel ceiling would be a lie at exactly the widths that matter.
 */
export const STATUS_VALUE_MAX_CHARS = 13;

/**
 * The normalized reasoning-effort ladder, lowest to highest.
 *
 * Exactly OpenAI's six variants ∪ Anthropic's `max` — the union, not a DorkOS
 * invention, so every runtime maps INTO it rather than the other way round. It
 * lives in this dependency-free module because two schema files need it and they
 * sit on opposite sides of one import edge: `schemas.ts` builds `EffortLevelSchema`
 * from it, and `config-schema.ts` builds the per-runtime `defaultEffort` leaves
 * from it. Importing one from the other would close a load-time cycle
 * (`schemas.ts` already imports `config-schema.ts`), and copying the list into
 * both is how the enum silently forks.
 *
 * Not every runtime honors every rung: claude-code and codex clamp `none`/`minimal`
 * differently (documented at both clamp sites), and OpenCode's API accepts no
 * effort at all. Those are mapping decisions at the adapter edge, never a reason
 * to fork the ladder.
 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'] as const;

/**
 * Runtimes whose API has no way to ask for more or less thinking.
 *
 * One entry today: OpenCode's prompt body carries no effort field in either the
 * pinned or the current SDK — effort exists there only as config-file variants
 * with no API selection.
 */
const RUNTIMES_WITHOUT_EFFORT: readonly string[] = ['opencode'];

/**
 * Whether a runtime can honor a reasoning effort at all.
 *
 * The single answer to a question three layers ask independently: what a new
 * session inherits, what a stored row is allowed to display, and what an adapter
 * persists. Answering it in one place is what keeps "Not supported by OpenCode"
 * literally true — a `false` here means no effort reaches the session, the
 * screen, or the store, rather than one layer suppressing a value the next one
 * still carries.
 *
 * Per RUNTIME, not per model. Whether a model within a supporting runtime honors
 * a given rung is a catalog question (`ModelOption.supportsEffort`) answered
 * against live data; this is the coarser, structural fact that holds even with
 * every catalog offline.
 *
 * @param runtimeType - A runtime type id (`'claude-code'`, `'codex'`, `'opencode'`, …).
 * @returns `false` only for a runtime known to have no effort at its API;
 *   unknown runtimes answer `true`, so a new adapter is never silently muted.
 */
export function runtimeSupportsEffort(runtimeType: string | undefined): boolean {
  return runtimeType === undefined || !RUNTIMES_WITHOUT_EFFORT.includes(runtimeType);
}
