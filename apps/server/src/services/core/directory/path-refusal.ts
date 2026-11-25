/**
 * A refused path as a capability's refusal: the boundary's answer
 * (`lib/boundary.ts`) and a path the operating system could not follow, as the
 * `CapabilityToolError` codes the HTTP doors answer with the same problem the
 * hand routes did (`http/problems/boundary-refusal.ts`).
 *
 * @module services/core/directory/path-refusal
 */
import { BoundaryError } from '../../../lib/boundary.js';
import { CapabilityToolError } from '../capabilities/index.js';

/** The tool codes a refused path answers with, each with its problem in `capability-refusals.ts`. */
export const PATH_REFUSAL_CODES = {
  /** A path with a NUL byte: `400 invalid_request`. */
  nullByte: 'PATH_NULL_BYTE',
  /** A path outside the folders DorkOS may use: `403 outside_boundary`. */
  outside: 'PATH_OUTSIDE_BOUNDARY',
  /** A folder the operating system would not let DorkOS read: `403 forbidden`. */
  notReadable: 'FOLDER_NOT_READABLE',
  /** A path that loops, runs through a file or is too long: `400 invalid_request`. */
  unfollowable: 'PATH_UNFOLLOWABLE',
} as const;

/**
 * The refusal for a path the boundary check refused, or `null` when the error
 * is something else.
 *
 * @param err - What `validateBoundary` (or a sibling) threw.
 */
export function boundaryToolError(err: unknown): CapabilityToolError | null {
  if (!(err instanceof BoundaryError)) return null;
  const code =
    err.code === 'NULL_BYTE'
      ? PATH_REFUSAL_CODES.nullByte
      : err.code === 'OUTSIDE_BOUNDARY'
        ? PATH_REFUSAL_CODES.outside
        : PATH_REFUSAL_CODES.notReadable;
  return new CapabilityToolError({ error: err.message, code });
}

/**
 * The refusal for a path the file guards refused (`lib/file-route-guards.ts`):
 * the boundary's refusal, or a path the operating system could not follow.
 * `null` for an unexpected error, which the caller lets fail as a 500.
 *
 * @param err - What `resolveWithinCwd` (or a sibling) threw.
 */
export function pathToolError(err: unknown): CapabilityToolError | null {
  const boundary = boundaryToolError(err);
  if (boundary) return boundary;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
    return new CapabilityToolError({
      error: 'That path can’t be followed.',
      code: PATH_REFUSAL_CODES.unfollowable,
    });
  }
  return null;
}
