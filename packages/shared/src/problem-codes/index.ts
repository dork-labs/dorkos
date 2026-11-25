/**
 * The failure code list, one file per group of codes so the list can grow
 * without any file outgrowing the line limit. Add a code to the group it
 * belongs to, at the end; a new group goes at the end of the list below. The
 * order is the order of the `ProblemCode` enum in the API document.
 *
 * Read it through `@dorkos/shared/problem`, never from here.
 *
 * @module shared/problem-codes
 */
import { CHAT_AND_APP_PROBLEM_CODES } from './chats-and-apps.js';
import type { ProblemCodeDefinition } from './definition.js';
import { GENERAL_PROBLEM_CODES } from './general.js';
import { SPACE_AND_COMPUTER_PROBLEM_CODES } from './spaces-and-computers.js';
import { WORKSPACE_AND_ACCESS_PROBLEM_CODES } from './workspace-and-access.js';

export type { ProblemCodeDefinition } from './definition.js';

/** Every group's codes, in the list's stable order. */
export const ALL_PROBLEM_CODES = [
  ...GENERAL_PROBLEM_CODES,
  ...CHAT_AND_APP_PROBLEM_CODES,
  ...WORKSPACE_AND_ACCESS_PROBLEM_CODES,
  ...SPACE_AND_COMPUTER_PROBLEM_CODES,
] as const satisfies readonly ProblemCodeDefinition[];
