/** Complete synthetic homes for native positive controls; never used by production. */
import fs from 'node:fs';
import path from 'node:path';
import type { CodexFilePolicy } from '../../../policy/protected-profile.js';
import { PROTECTED_PATHS } from '../../../../shared/policy/protected-paths.js';

export function completeHostFixture(policy: CodexFilePolicy, allBases: string[]): Set<string> {
  const protectedFiles = new Set<string>();
  for (const entry of PROTECTED_PATHS) {
    if (/[*?[\]{}]/.test(entry.path)) continue;
    const bases =
      entry.root === 'data'
        ? [policy.roots.data]
        : entry.root === 'home'
          ? [policy.roots.home]
          : entry.root === 'account'
            ? policy.roots.accounts
            : entry.root === 'agent-home'
              ? policy.roots.agentHomes
              : allBases;
    for (const base of bases) {
      const target = path.join(base, entry.path);
      if (entry.kind === 'folder') fs.mkdirSync(target, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!fs.existsSync(target)) fs.writeFileSync(target, '{}');
        protectedFiles.add(target);
      }
    }
  }
  return protectedFiles;
}
