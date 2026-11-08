/** Writable host binds must never synthesize missing protected file targets. */
import type { SessionSettings } from '@dorkos/shared/types';
import path from 'node:path';
import os from 'node:os';
import { realPathOf } from '@dorkos/shared/directory-grants';
import type { CodexFilePolicy } from './protected-profile.js';

/** Refuse explicitly; never downgrade the person's chosen permission level. */
export class CodexWritableMissingTargetsError extends Error {
  constructor(
    readonly missingPaths: readonly string[],
    readonly mode = 'bypassPermissions'
  ) {
    super(
      mode === 'bypassPermissions'
        ? 'Codex can’t use Full access while protected files are missing. Choose Ask, then retry.'
        : 'Codex can’t edit while protected files are missing. Choose Ask, then retry.'
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
