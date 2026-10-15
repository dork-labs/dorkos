import type { PermissionMode } from '@dorkos/shared/types';

/**
 * Translate the permission mode the SDK recorded in a transcript into the
 * DorkOS mode a session row reports, or `undefined` when the value is not one
 * this build knows.
 *
 * Every mode Claude Code declares needs its own entry here. A missing arm does
 * not fail loudly — it silently reports a permissive session as `default`, so
 * the list tells the operator a session is prompting on every tool while it is
 * really running unattended. `dangerously-skip` is the SDK's older spelling of
 * `bypassPermissions` and still appears in transcripts written by older CLIs.
 */
export function normalizeTranscriptPermissionMode(sdkMode: string): PermissionMode | undefined {
  switch (sdkMode) {
    case 'bypassPermissions':
    case 'dangerously-skip':
      return 'bypassPermissions';
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'auto':
      return 'auto';
    case 'dontAsk':
      return 'dontAsk';
    case 'default':
      return 'default';
    default:
      return undefined;
  }
}
