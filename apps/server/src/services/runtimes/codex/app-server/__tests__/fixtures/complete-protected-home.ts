/** Complete synthetic homes for native positive controls; never used by production. */
import fs from 'node:fs';
import path from 'node:path';
import type { CodexFilePolicy } from '../../../policy/protected-profile.js';
import { PROTECTED_PATHS } from '../../../../shared/policy/protected-paths.js';

/** The made-up name of the sign-in backup Claude Code writes into each `backups` folder. */
export const FIXTURE_BACKUP_NAME = '.claude.json.backup.1794126006599';

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
      if (entry.kind === 'folder') {
        fs.mkdirSync(target, { recursive: true });
        // Glob rules plant nothing above, so seed the file a real Claude Code
        // home has: a sign-in backup inside a hidden folder (DOR-3949).
        if (path.basename(target) === 'backups') {
          const backup = path.join(target, FIXTURE_BACKUP_NAME);
          if (!fs.existsSync(backup)) fs.writeFileSync(backup, '{}');
          protectedFiles.add(backup);
        }
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!fs.existsSync(target)) fs.writeFileSync(target, '{}');
        protectedFiles.add(target);
      }
    }
  }
  return protectedFiles;
}
