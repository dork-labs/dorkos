/**
 * Real-path spelling for room canvas comparisons, moved out of
 * `room-canvas-service.ts` unchanged.
 *
 * @module services/rooms/canvas/canonical-path
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * A path's real spelling: the real path of its deepest existing ancestor with
 * the rest appended, so a file that does not exist yet still compares by the
 * folder it would land in.
 */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved
      ? resolved
      : path.join(canonicalPath(parent), path.basename(resolved));
  }
}
