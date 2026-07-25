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
 * The longest value the composer's status line may render, in characters.
 *
 * The line's width budget counts slots, and a count only holds while every slot
 * is about one size — so every value is bounded to this before it is drawn, and
 * anything longer is cut with an ellipsis.
 *
 * Lives here rather than in the client because it is a **contract with runtime
 * authors**, not a private UI detail: a first-party catalog DorkOS writes
 * (`CODEX_MODELS`, a runtime's permission-mode labels) is expected to fit
 * outright, and the server's own tests assert it. Third-party strings a runtime
 * merely relays — a provider's model display name from OpenCode's catalog — are
 * bounded on the way out instead of rejected, which is what this number is for.
 *
 * 13 is the width of the longest first-party name (`GPT-5.3 Codex`). Deliberately
 * counted in characters, not pixels: the composer's `text-xs` is 1.25× larger
 * below 768px and scales again with `--user-font-scale`, so a pixel ceiling would
 * be a lie at exactly the widths that matter.
 */
export const STATUS_VALUE_MAX_CHARS = 13;
