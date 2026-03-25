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

/** Number of digits in a remote-access passcode. */
export const PASSCODE_LENGTH = 6;

/** Maximum age of a passcode session cookie in milliseconds (24 hours). */
export const PASSCODE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Rate-limit window for passcode verification attempts in milliseconds (15 minutes). */
export const PASSCODE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Maximum passcode verification attempts within the rate-limit window. */
export const PASSCODE_RATE_LIMIT_MAX = 10;
