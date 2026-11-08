/** Writable host binds must never synthesize missing protected file targets. */
import type { SessionSettings } from '@dorkos/shared/types';
import path from 'node:path';
import os from 'node:os';
import { realPathOf } from '@dorkos/shared/directory-grants';
import type { CodexFilePolicy } from './protected-profile.js';

/**
 * How a person adds one missing target, for the two an agent folder usually
 * lacks (DOR-3914). Any other target gets no advice beyond Ask: creating, say,
 * an empty `.git` would do harm.
 */
function addPhrase(target: string): string | undefined {
  const name = path.basename(target);
  if (name === '.agents') return `the folder ${target}`;
  if (name === '.mcp.json') return `${target} with the text {"mcpServers":{}}`;
  return undefined;
}

/** The Edit refusal: it names only the missing paths, and how to add them. */
function editRefusal(missingPaths: readonly string[]): string {
  const adds = missingPaths.map(addPhrase);
  if (adds.length > 0 && adds.every((add) => add !== undefined))
    return `Codex can’t edit until you add ${adds.join(' and ')}. Or choose Ask, then retry.`;
  const verb = missingPaths.length === 1 ? 'is' : 'are';
  return `Codex can’t edit while ${missingPaths.join(', ')} ${verb} missing. Choose Ask, then retry.`;
}

/** Refuse explicitly; never downgrade the person's chosen permission level. */
export class CodexWritableMissingTargetsError extends Error {
  constructor(
    readonly missingPaths: readonly string[],
    readonly mode = 'bypassPermissions'
  ) {
    super(
      mode === 'bypassPermissions'
        ? 'Codex can’t use Full access while protected files are missing. Choose Ask, then retry.'
        : editRefusal(missingPaths)
    );
    this.name = 'CodexWritableMissingTargetsError';
  }
}

/** Check the exact missing literals collected while rendering every mask. */
export function refuseMissingWritableTargets(
  settings: Pick<SessionSettings, 'permissionMode'>,
  targets: readonly string[],
  policy?: CodexFilePolicy
): void {
  const mode = settings.permissionMode;
  // :workspace includes the cwd, explicit grants and the two native tmp roots.
  const roots = policy ? [policy.roots.cwd, ...policy.writable, os.tmpdir(), '/tmp'] : undefined;
  const missing =
    mode === 'acceptEdits' && roots
      ? targets.filter((target) =>
          roots.some((root) => {
            const base = realPathOf(root);
            const file = realPathOf(target);
            return file === base || file.startsWith(base + path.sep);
          })
        )
      : targets;
  if (
    process.platform === 'linux' &&
    (mode === 'bypassPermissions' || mode === 'acceptEdits') &&
    missing.length
  )
    throw new CodexWritableMissingTargetsError([...new Set(missing)].sort(), mode);
}

/** Production load recording rechecks the actual render after pre-acquire inspection. */
export function guardedMountTargetRecorder(
  settings: Pick<SessionSettings, 'permissionMode'>,
  record?: (targets: string[]) => void,
  policy?: CodexFilePolicy
): ((targets: string[]) => void) | undefined {
  return record
    ? (targets) => {
        refuseMissingWritableTargets(settings, targets, policy);
        record(targets);
      }
    : undefined;
}
