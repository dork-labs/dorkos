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
