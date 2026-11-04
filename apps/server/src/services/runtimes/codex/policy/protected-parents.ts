/** Prepare only parents, never the protected targets or a path through a link. */
import fs from 'node:fs';
import path from 'node:path';
import type { SessionSettings } from '@dorkos/shared/types';
import { PROTECTED_PATHS } from '../../shared/policy/protected-paths.js';
import { MODE_TO_SANDBOX } from '../turn-input.js';
import { codexPermissionProfile, type CodexFilePolicy } from './protected-profile.js';

/** Prepare only an explicitly captured launch policy, never config fingerprints. */
export function prepareCodexLoadParents(
  policy: CodexFilePolicy | undefined,
  config: Readonly<Record<string, unknown>> | undefined,
  settings: Pick<SessionSettings, 'permissionMode'>
): void {
  const mode = MODE_TO_SANDBOX[settings.permissionMode ?? 'default'];
  if (mode !== 'workspace-write' && mode !== 'danger-full-access') return;
  const permissions = config?.permissions as
    Record<string, { filesystem: Record<string, unknown> }> | undefined;
  const filesystem = permissions?.[codexPermissionProfile(settings)]?.filesystem;
  if (policy && filesystem) prepareCodexProtectedParents(policy, filesystem);
}

/** Select only rendered literal rules belonging to this launch's own homes. */
export function prepareCodexProtectedParents(
  policy: CodexFilePolicy,
  filesystem: Readonly<Record<string, unknown>>
): void {
  const owned = new Set((policy.ownAgentHomes ?? []).map((home) => path.resolve(home)));
  const ownAgentHomes = policy.roots.agentHomes.filter((home) => owned.has(path.resolve(home)));
  const ownRules: Record<string, unknown> = {};
  for (const entry of PROTECTED_PATHS) {
    const homes =
      entry.root === 'data'
        ? [policy.roots.data]
        : entry.root === 'agent-home'
          ? ownAgentHomes
          : [];
    for (const home of homes) {
      // Only lexical spellings are eligible: never resolve an alias to create
      // directories at its destination. Other agents' literal rules stay intact.
      const file = path.join(path.resolve(home), entry.path).split(path.sep).join('/');
      if (Object.hasOwn(filesystem, file)) ownRules[file] = filesystem[file];
    }
  }
  prepareProtectedParents(ownRules, [policy.roots.data, ...ownAgentHomes]);
}

/** Missing or obstructed paths retain their rules; Codex decides whether it can launch. */
export function prepareProtectedParents(
  literalRules: Readonly<Record<string, unknown>>,
  ownHomes: readonly string[]
): void {
  const homes = [...new Set(ownHomes.map((home) => path.resolve(home)))];
  for (const file of Object.keys(literalRules)) {
    if (!path.isAbsolute(file) || /[*?[\]{}]/.test(file)) continue;
    const parent = path.dirname(file);
    const home = homes
      .filter((candidate) => {
        const relative = path.relative(candidate, parent);
        return (
          relative === '' ||
          (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        );
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!home) continue;
    let current = path.parse(parent).root;
    for (const segment of parent.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const entry = fs.lstatSync(current);
        if (!entry.isDirectory() || entry.isSymbolicLink()) break;
      } catch (error) {
        // Never create ancestors outside the captured home, and never treat
        // inaccessible paths as missing. mkdir is deliberately non-recursive.
        const relative = path.relative(home, current);
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          break;
        try {
          fs.mkdirSync(current, { mode: 0o700 });
          const made = fs.lstatSync(current);
          if (!made.isDirectory() || made.isSymbolicLink()) break;
        } catch {
          break;
        }
      }
    }
  }
}
