import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Host-authorized existing tree; this is never authorization derived from a page path. */
export interface TrustedTreeRoot {
  readonly directory: string;
}

/** Actual canonical directory and complete physical ancestry, resolved outside SQL. */
export interface TreeRootIdentity {
  readonly canonicalPath: string;
  readonly physicalKey: string;
  readonly ancestorPhysicalKeys: readonly string[];
}

/** Mandatory probe; composition supplies filesystem and transaction confinement. */
export interface TreeRootProbe {
  resolve(root: TrustedTreeRoot): Promise<TreeRootIdentity>;
}

/** Private protocol refusal; outward error mapping belongs to authenticated composition. */
export class MutationRefusal extends Error {
  constructor(
    readonly code:
      | 'invalid-root'
      | 'root-changed'
      | 'root-limit'
      | 'queue-limit'
      | 'closing'
      | 'reentrant'
      | 'invalid-mode'
      | 'inactive'
      | 'unresolved'
      | 'invalid-path'
      | 'namespace-changed'
      | 'collision'
      | 'cleanup-ownership'
  ) {
    super(`Installation mutation refused: ${code}`);
    this.name = 'MutationRefusal';
  }
}

/** Probe actual directories and ancestors; no inferred namespace or hardlink alias census. */
export const filesystemMutationRootProbe: TreeRootProbe = {
  async resolve(root) {
    if (!path.isAbsolute(root.directory)) throw new MutationRefusal('invalid-root');
    const canonicalPath = await realpath(root.directory);
    const info = await stat(canonicalPath, { bigint: true });
    if (!info.isDirectory()) throw new MutationRefusal('invalid-root');
    const ancestorPhysicalKeys: string[] = [];
    let parent = path.dirname(canonicalPath);
    while (parent !== canonicalPath) {
      const ancestor = await stat(parent, { bigint: true });
      if (!ancestor.isDirectory()) throw new MutationRefusal('invalid-root');
      ancestorPhysicalKeys.push(`${ancestor.dev}:${ancestor.ino}`);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return Object.freeze({
      canonicalPath,
      physicalKey: `${info.dev}:${info.ino}`,
      ancestorPhysicalKeys: Object.freeze(ancestorPhysicalKeys),
    });
  },
};

/** Exact physical and canonical equality; a moved root must be newly authorized, never rebound. */
export function sameMutationRoot(a: TreeRootIdentity, b: TreeRootIdentity): boolean {
  return (
    a.canonicalPath === b.canonicalPath &&
    a.physicalKey === b.physicalKey &&
    a.ancestorPhysicalKeys.length === b.ancestorPhysicalKeys.length &&
    a.ancestorPhysicalKeys.every((key, index) => key === b.ancestorPhysicalKeys[index])
  );
}
