/**
 * The expected answers `mesh-groups.contract.test.ts` shares between its cases,
 * kept beside it so the suite stays under its line budget.
 *
 * @module http/__tests__/contract/mesh-groups.fixtures
 */
import { z } from 'zod';
import { problemBody, validationProblemBody } from '@dorkos/http-kit';
import { EXECUTION_NEEDS_APPROVAL_DETAIL } from '../../../services/core/operator/agent-execution.js';

/** `JSON_TYPE`: one expected answer the contract cases share. */
export const JSON_TYPE = { 'content-type': /^application\/json\b/ };
/** `NOT_FOUND`: one expected answer the contract cases share. */
export const NOT_FOUND = problemBody('not_found', {
  detail: 'This server has no API route at that path.',
});
/** `PROBLEM_TYPE`: one expected answer the contract cases share. */
export const PROBLEM_TYPE = { 'content-type': /^application\/problem\+json\b/ };
/** `AGENT_NOT_FOUND`: one expected answer the contract cases share. */
export const AGENT_NOT_FOUND = problemBody('not_found', { detail: 'No agent with that id.' });
/** `OUTSIDE`: one expected answer the contract cases share. */
export const OUTSIDE = problemBody('outside_boundary', {
  detail: 'Pick a folder inside the ones DorkOS may use.',
});
/** `NO_PATH`: one expected answer the contract cases share. */
export const NO_PATH = problemBody('invalid_request', {
  detail: 'Send the agent’s folder as `path`.',
});
// The persona move names the field since it moved onto the mount (DOR-4978).
/** `NO_PATH_FIELD`: one expected answer the contract cases share. */
export const NO_PATH_FIELD = validationProblemBody({
  fieldErrors: { path: ['Send the agent’s folder as `path`.'] },
  formErrors: [],
});
/** `NO_AGENT_HERE`: one expected answer the contract cases share. */
export const NO_AGENT_HERE = problemBody('not_found', {
  detail: 'No agent is registered in that folder.',
});
/** An agent header this machine never minted: the caller is a machine, unverified. */
export const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
/** A ULID nothing in a fresh install has. */
export const UNKNOWN_ULID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
/** `VALIDATION_FAILED`: one expected answer the contract cases share. */
export const VALIDATION_FAILED = z
  .object({ code: z.literal('invalid_request'), issues: z.unknown() })
  .loose();
/** `NEEDS_APPROVAL`: one expected answer the contract cases share. */
export const NEEDS_APPROVAL = problemBody('needs_approval', {
  detail: EXECUTION_NEEDS_APPROVAL_DETAIL,
});
/** `MALFORMED_JSON`: one expected answer the contract cases share. */
export const MALFORMED_JSON = z.object({ code: z.literal('malformed_request') }).loose();
/** `AGENT_LIST`: one expected answer the contract cases share. */
export const AGENT_LIST = z
  .object({ agents: z.array(z.object({ id: z.string() }).loose()) })
  .strict();
/** `EVENT_STREAM`: one expected answer the contract cases share. */
export const EVENT_STREAM = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'x-accel-buffering': 'no',
};
