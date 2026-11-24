/**
 * The problem documents the agent identity routes (`routes/agents.ts`) answer
 * with when a request names no agent, or creating or editing one is refused
 * (DOR-4979).
 *
 * @module routes/agents-problems
 */
import type { Context } from 'hono';
import { problem, sendProblem, validationProblemBody } from '@dorkos/http-kit';
import { ProblemIssuesSchema } from '@dorkos/shared/problem';
import { logger } from '../lib/logger.js';
import type { AgentCreationError } from '../services/core/agent-creator.js';
import type { AgentUpdateError } from '../services/core/operator/agent-updater.js';

/**
 * Answer a request that named no folder in `?path=`.
 *
 * @param c - The Hono context.
 * @returns The response.
 */
export function missingPath(c: Context): Response {
  return problem(c, 'invalid_request', { detail: 'Send the agent’s folder as `path`.' });
}

/**
 * Answer a request whose folder holds no agent.
 *
 * @param c - The Hono context.
 * @returns The response.
 */
export function noAgentHere(c: Context): Response {
  return problem(c, 'not_found', { detail: 'No agent is registered in that folder.' });
}

/**
 * Answer a creation `createAgentWorkspace` refused. A template that could not
 * be fetched says why and what happened to the folder; a scaffold that failed
 * is logged and answered without its message, which names the folder.
 *
 * @param c - The Hono context.
 * @param err - The refusal.
 * @returns The response.
 */
export function creationProblem(c: Context, err: AgentCreationError): Response {
  switch (err.code) {
    case 'VALIDATION':
      return problem(c, 'invalid_request', { detail: err.message });
    case 'BOUNDARY':
      return problem(c, 'outside_boundary', {
        detail: 'Pick a folder inside the ones DorkOS may use.',
      });
    case 'COLLISION':
      return problem(c, 'conflict', { detail: err.message });
  }
  // A template that could not be downloaded carries the download's own words
  // (git, the network): they go to the log, and the caller gets a fixed sentence.
  if (err.code === 'TEMPLATE') {
    logger.error('[agents] template download failed', { err });
    return err.statusCode < 500
      ? problem(c, 'invalid_request', {
          detail: 'DorkOS can’t download a template from that address.',
        })
      : problem(c, 'internal_error', {
          detail: 'The template couldn’t be downloaded. Try again.',
        });
  }
  if (err.statusCode < 500) return problem(c, 'invalid_request', { detail: err.message });
  logger.error('[agents] agent creation failed', { err });
  return problem(c, 'internal_error', { detail: 'The agent couldn’t be set up. Try again.' });
}

/**
 * Answer an edit `updateAgentManifest` refused, in the sentence it gave: a
 * refused convention file names which file and why, and the editor shows it.
 *
 * @param c - The Hono context.
 * @param err - The refusal.
 * @returns The response.
 */
export function updateProblem(c: Context, err: AgentUpdateError): Response {
  switch (err.code) {
    case 'VALIDATION': {
      const issues = ProblemIssuesSchema.safeParse(err.details);
      // "Validation failed" says nothing a field-by-field detail does not.
      const detail = err.message === 'Validation failed' ? undefined : err.message;
      return issues.success
        ? sendProblem(c, validationProblemBody(issues.data, detail ? { detail } : {}))
        : problem(c, 'invalid_request', { detail: err.message });
    }
    case 'NOT_FOUND':
      return problem(c, 'not_found', { detail: 'No agent is registered in that folder.' });
    case 'SYSTEM_PROTECTED':
      return problem(c, 'forbidden', { detail: err.message });
    case 'OPERATOR_ONLY':
      return problem(c, 'operator_only', { detail: err.message });
    case 'UNSUPPORTED_MODEL':
      return problem(c, 'invalid_request', { detail: err.message });
    case 'REPORTS_TO_CYCLE':
      return problem(c, 'reports_to_cycle', { detail: err.message });
  }
}
