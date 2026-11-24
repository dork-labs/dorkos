/**
 * The problem documents the Mesh routes (`routes/mesh.ts`,
 * `routes/mesh-agent-patch-http.ts`) answer with (DOR-4979).
 *
 * @module routes/mesh-problems
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import { InsideRoomFilesError, ManifestUnreadableError } from '@dorkos/mesh';
import { logger } from '../lib/logger.js';

/**
 * Answer a folder the boundary refused. The sentence names no path.
 *
 * @param c - The Hono context.
 * @returns The response.
 */
export function outsideBoundary(c: Context): Response {
  return problem(c, 'outside_boundary', {
    detail: 'Pick a folder inside the ones DorkOS may use.',
  });
}

/**
 * Answer a request for an agent the registry does not hold.
 *
 * @param c - The Hono context.
 * @returns The response.
 */
export function agentNotFound(c: Context): Response {
  return problem(c, 'not_found', { detail: 'No agent with that id.' });
}

/**
 * Answer an agent whose `.dork/agent.json` is there but cannot be read, so
 * writing over it would erase what only it holds.
 *
 * @param c - The Hono context.
 * @param status - The status this route has always answered it with.
 * @returns The response.
 */
export function manifestUnreadable(c: Context, status: 409 | 422 = 409): Response {
  return problem(c, 'conflict', {
    status,
    detail: 'This folder’s .dork/agent.json can’t be read. Fix or remove it, then try again.',
  });
}

/**
 * Answer a registration `registerByPath` refused: a room's folder, a manifest
 * that cannot be read, or a folder with no manifest and no name to make one.
 *
 * @param c - The Hono context.
 * @param err - What it threw.
 * @returns The response.
 */
export function registrationProblem(c: Context, err: unknown): Response {
  if (err instanceof InsideRoomFilesError) {
    return problem(c, 'invalid_request', {
      status: 422,
      detail: 'A room’s folder can’t be an agent’s home. Pick another folder.',
    });
  }
  if (err instanceof ManifestUnreadableError) return manifestUnreadable(c, 422);
  return unprocessable(c, err, 'This folder couldn’t be registered as an agent.');
}

/**
 * Answer a Mesh write the registry refused for a reason of its own, in its own
 * sentence when it gave one.
 *
 * @param c - The Hono context.
 * @param err - What the registry threw.
 * @param fallback - The sentence when it gave none.
 * @returns The response.
 */
export function unprocessable(c: Context, err: unknown, fallback: string): Response {
  // The thrown message stays in the log: it can name a folder or carry a
  // library's own words, and a problem's detail never does.
  logger.warn('[mesh] write refused', { err });
  return problem(c, 'invalid_request', { status: 422, detail: fallback });
}
