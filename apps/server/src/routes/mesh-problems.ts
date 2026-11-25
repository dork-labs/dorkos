/**
 * The problem documents the hand-served Mesh routes (`routes/mesh.ts`,
 * `routes/mesh-agent-patch-http.ts`) answer with (DOR-4979). The doors the
 * capability mount serves refuse through `services/mesh/doors/mesh-refusals.ts`.
 *
 * @module routes/mesh-problems
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';

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
 * @returns The response.
 */
export function manifestUnreadable(c: Context): Response {
  return problem(c, 'conflict', {
    detail: 'This folder’s .dork/agent.json can’t be read. Fix or remove it, then try again.',
  });
}
