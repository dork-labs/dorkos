/** Merge literal refusals that would otherwise mask one missing ancestor repeatedly. */
import fs from 'node:fs';
import path from 'node:path';
import { realPathOf } from '@dorkos/shared/directory-grants';

type Access = 'read' | 'deny';

/** Read-only inspection: links exist; inaccessible or non-directory ancestors refuse. */
function firstMissing(file: string): string {
  let candidate = file;
  let missing: string | undefined;
  for (;;) {
    try {
      fs.lstatSync(candidate);
      // Resolve only the existing parent of a missing component. Two lexical
      // aliases of that parent must not produce two mounts for the same target.
      return missing ? path.join(realPathOf(candidate), path.basename(missing)) : file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/** Globs retain their spelling; the strongest refusal wins each collapsed key. */
export function collapseProtectedPaths(
  entries: Readonly<Record<string, Access>>
): Record<string, Access> {
  const collapsed: Record<string, Access> = {};
  for (const [file, access] of Object.entries(entries)) {
    const target = /[*?[\]{}]/.test(file) ? file : firstMissing(file).split(path.sep).join('/');
    collapsed[target] = access === 'deny' || collapsed[target] === 'deny' ? 'deny' : 'read';
  }
  return collapsed;
}
