/** Merge literal refusals that would otherwise mask one missing ancestor repeatedly. */
import fs from 'node:fs';
import path from 'node:path';
import { realPathOf } from '@dorkos/shared/directory-grants';

type Access = 'read' | 'deny';

/** A real file occupies a path that a protected descendant needs as a folder. */
export class ProtectedPathNotDirectoryError extends Error {
  readonly code = 'ENOTDIR';

  constructor(
    readonly blockingPath: string,
    cause: Error
  ) {
    super(`Codex needs ${blockingPath} to be a folder. Rename the file, then retry.`, { cause });
    this.name = 'ProtectedPathNotDirectoryError';
  }
}

/** Locate the blocking file without following links or changing the filesystem. */
function explainNotDirectory(file: string, original: Error): never {
  for (let candidate = file; ; candidate = path.dirname(candidate)) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (stat?.isFile()) throw new ProtectedPathNotDirectoryError(candidate, original);
    // An existing link or directory does not prove which file obstructed the
    // original lookup. Preserve that refusal rather than inventing a fix.
    if (stat || path.dirname(candidate) === candidate) throw original;
  }
}

/** Read-only inspection: links exist; inaccessible or non-directory ancestors refuse. */
function firstMissing(file: string): string | undefined {
  let candidate = file;
  let missing: string | undefined;
  for (;;) {
    try {
      fs.lstatSync(candidate);
      return missing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR')
        explainNotDirectory(candidate, error as Error);
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
  bases: readonly string[],
  onMissing?: (target: string) => void,
  allowBlocking?: (target: string) => boolean
): Record<string, Access> {
  const collapsed: Record<string, Access> = {};
  for (const [file, access] of Object.entries(entries)) {
    let missing: string | undefined;
    let blocking: string | undefined;
    try {
      missing = /[*?[\]{}]/.test(file) ? undefined : firstMissing(file);
    } catch (error) {
      if (
        !(error instanceof ProtectedPathNotDirectoryError) ||
        !allowBlocking?.(error.blockingPath)
      )
        throw error;
      blocking = error.blockingPath;
    }
    const target = (missing || blocking ? throughBase((missing ?? blocking)!, bases) : file)
      .split(path.sep)
      .join('/');
    if (missing) onMissing?.(target);
    collapsed[target] = access === 'deny' || collapsed[target] === 'deny' ? 'deny' : 'read';
  }
  return collapsed;
}
