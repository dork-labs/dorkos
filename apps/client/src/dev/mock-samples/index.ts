/**
 * Sample/fixture data for dev playground showcases, split by domain.
 *
 * Was one 1,187-line file mixing roughly eight unrelated concerns — batch 20
 * audit finding 20.8 (DOR-1766) split it along the domain boundaries already
 * visible in its `export const` list, the same discipline
 * `sections/features-agent-sections.ts` and `features-surface-sections.ts`
 * already applied to playground _sections_.
 * Re-exported from this one barrel so no import site changes: every consumer
 * still writes `from '../mock-samples'` or `from './mock-samples'`, which
 * resolves here exactly as it resolved to the single file before.
 *
 * @module dev/mock-samples
 */
export { BACKGROUND_TASK_PARTS, ERROR_PARTS } from './tool-parts';
export { SAMPLE_TASKS } from './tasks';
export {
  SAMPLE_MESSAGES,
  SAMPLE_QUESTIONS,
  TOOL_CALL_MULTI_QUESTION,
  SAMPLE_MESSAGE_MULTI_QUESTION,
  TOOL_CALL_MULTI_SELECT_QUESTION,
  SAMPLE_MESSAGE_MULTI_SELECT,
} from './chat';
export { SAMPLE_FILES, SAMPLE_FILE_ENTRIES } from './files';
export { SAMPLE_QUEUE, SAMPLE_QUEUE_MIXED_ORIGINS } from './queue';
export { SAMPLE_COMMANDS, SAMPLE_COMMANDS_LONG } from './commands';
export { SESSION_DIAGNOSTICS } from './session-diagnostics';
export {
  IDENTITY_STATUSES,
  MOCK_IDENTITIES,
  MOCK_TEAM_ROSTER,
  withSuggestedName,
} from './identity';
export type { MockIdentity } from './identity';
export { HUMAN_AUTHOR, AGENT_AUTHOR } from './message-authors';
