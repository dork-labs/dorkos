/**
 * The words the permissions pages use for a state and for where it came from.
 * One place, so the Settings page, an agent's page and the dialog cannot
 * describe the same state three ways.
 *
 * @module features/permissions/lib/permission-copy
 */
import type {
  FilesAndCommandsSource,
  PermissionPreset,
  PermissionSource,
  PermissionState,
} from '@dorkos/shared/permissions';

/** A state as a person reads it. */
export const STATE_LABEL: Record<PermissionState, string> = {
  blocked: 'Blocked',
  ask: 'Ask',
  allowed: 'Allowed',
};

/** A preset as a person reads it. */
export const PRESET_LABEL: Record<PermissionPreset, string> = {
  careful: 'Careful',
  balanced: 'Balanced',
  full: 'Full power',
};

/** What each preset means, in one line. */
export const PRESET_SUMMARY: Record<PermissionPreset, string> = {
  careful: 'Agents ask before they change anything, and can’t reach outside DorkOS.',
  balanced: 'Agents run their rooms and ask before anything wider.',
  full: 'Agents do the everyday work themselves and ask before installing or changing settings.',
};

/**
 * The short line under a default-layer row saying where its state came from.
 *
 * @param source - The resolved source.
 * @param preset - The chosen preset, or `null` for not chosen yet.
 */
export function defaultSourceText(
  source: PermissionSource,
  preset: PermissionPreset | null
): string {
  switch (source) {
    case 'default-area':
    case 'default-action':
      return 'Changed from your preset';
    case 'preset':
      return preset ? `From ${PRESET_LABEL[preset]}` : 'From your preset';
    case 'unchanged':
      return 'Not chosen yet, so it works as it did before';
    case 'floor':
      return 'Never Allowed';
    case 'always-asks':
      return 'Always asks, so you see what it would change';
    default:
      return '';
  }
}

/** What Blocked means, said once wherever it is explained. */
export const BLOCKED_IS_NOT_A_SANDBOX =
  "Blocked stops an agent that plays by the rules; it isn't a sandbox.";

/**
 * Where a Files & commands stop came from, in words.
 *
 * @param source - The resolved source.
 */
export function filesSourceText(source: FilesAndCommandsSource): string {
  switch (source) {
    case 'agent':
      return 'Set for this agent';
    case 'runtime':
      return 'Set for its runtime in Settings → Runtimes';
    case 'default':
      return 'The setting everyone has';
    case 'runtime-own':
      return 'Not set, so each runtime starts where it always has';
  }
}
