/**
 * The one answer to a path the boundary check refused (`lib/boundary.ts`): a
 * problem document (DOR-4979).
 *
 * A path outside the folders DorkOS may use is `403 outside_boundary`; a path
 * with a NUL byte is a bad path, `400 invalid_request`; a folder the operating
 * system would not let DorkOS read is `403 forbidden`. The sentences name no
 * path, so a refusal never tells a caller what lies outside.
 *
 * @module http/problems/boundary-refusal
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import { BoundaryError } from '../../lib/boundary.js';

/**
 * Answer a request whose path the boundary check refused.
 *
 * @param c - The Hono context.
 * @param err - The refusal `validateBoundary` (or a sibling) threw.
 * @returns The response.
 */
export function boundaryProblem(c: Context, err: BoundaryError): Response {
  if (err.code === 'NULL_BYTE') {
    return problem(c, 'invalid_request', { detail: 'That path has a character paths can’t hold.' });
  }
  if (err.code === 'OUTSIDE_BOUNDARY') {
    return problem(c, 'outside_boundary', {
      detail: 'Pick a folder inside the ones DorkOS may use.',
    });
  }
  return problem(c, 'forbidden', { detail: 'DorkOS isn’t allowed to read that folder.' });
}

/**
 * Answer a request whose path the file guards refused (`lib/file-route-guards.ts`):
 * the boundary's refusal, or a path the operating system could not follow.
 *
 * @param c - The Hono context.
 * @param err - What `resolveWithinCwd` (or a sibling) threw.
 * @returns The response, or `null` for an unexpected error the caller treats as a 500.
 */
export function pathRefusalProblem(c: Context, err: unknown): Response | null {
  if (err instanceof BoundaryError) return boundaryProblem(c, err);
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
    return problem(c, 'invalid_request', { detail: 'That path can’t be followed.' });
  }
  return null;
}
