/** Full's writable host bind must never synthesize protected mount targets. */
import type { SessionSettings } from '@dorkos/shared/types';

/** Refuse explicitly; never downgrade the person's chosen permission level. */
export class CodexFullMissingTargetsError extends Error {
  constructor(readonly missingPaths: readonly string[]) {
    super('Codex can’t use Full access while protected files are missing. Choose Ask, then retry.');
    this.name = 'CodexFullMissingTargetsError';
  }
}

/** Check the exact missing literals collected while rendering every mask. */
export function refuseMissingFullTargets(
  settings: Pick<SessionSettings, 'permissionMode'>,
  targets: readonly string[]
): void {
  if (
    process.platform === 'linux' &&
    settings.permissionMode === 'bypassPermissions' &&
    targets.length
  )
    throw new CodexFullMissingTargetsError([...new Set(targets)].sort());
}

/** Production load recording rechecks the actual render after pre-acquire inspection. */
export function guardedMountTargetRecorder(
  settings: Pick<SessionSettings, 'permissionMode'>,
  record?: (targets: string[]) => void
): ((targets: string[]) => void) | undefined {
  return record
    ? (targets) => {
        refuseMissingFullTargets(settings, targets);
        record(targets);
      }
    : undefined;
}
