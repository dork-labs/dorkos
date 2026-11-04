/** Merge literal refusals that would otherwise mask one missing ancestor repeatedly. */
import fs from 'node:fs';
import path from 'node:path';
import { realPathOf } from '@dorkos/shared/directory-grants';

type Access = 'read' | 'deny';

/** Read-only inspection: links exist; inaccessible or non-directory ancestors refuse. */
function firstMissing(file: string): string | undefined {
  let candidate = file;
  let missing: string | undefined;
  for (;;) {
    try {
      fs.lstatSync(candidate);
      return missing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/** Canonicalize a captured base only; links below it must remain visible to Codex. */
function throughBase(file: string, bases: readonly string[]): string {
  const base = bases
    .map((base) => path.resolve(base))
    .filter((base) => file === base || file.startsWith(base + path.sep))
    .sort((a, b) => b.length - a.length)[0];
  return base ? path.join(realPathOf(base), path.relative(base, file)) : file;
}

/** Globs retain their spelling; the strongest refusal wins each collapsed key. */
export function collapseProtectedPaths(
  entries: Readonly<Record<string, Access>>,
  bases: readonly string[]
): Record<string, Access> {
  const collapsed: Record<string, Access> = {};
  for (const [file, access] of Object.entries(entries)) {
    const missing = /[*?[\]{}]/.test(file) ? undefined : firstMissing(file);
    const target = (missing ? throughBase(missing, bases) : file).split(path.sep).join('/');
    collapsed[target] = access === 'deny' || collapsed[target] === 'deny' ? 'deny' : 'read';
  }
  return collapsed;
}
