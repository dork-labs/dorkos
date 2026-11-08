/** Options recorded by the injected scripted transport, never sent to a CLI. */
import type { ThreadOptions } from '@openai/codex-sdk';
import type { SessionSettings } from '@dorkos/shared/types';
import { EFFORT_TO_REASONING } from '../../turn-input.js';
import { codexPermissionProfile } from '../../policy/protected-profile.js';
/**
 * Project resolved session settings into the explicit ThreadOptions for one
 * turn.
 *
 * `skipGitRepoCheck` is always set: the CLI refuses to run outside a git
 * repository by default, but DorkOS sessions legitimately run in non-repo
 * directories (e.g. `~/.dork/agents/*`), and the read-only default sandbox
 * already provides the conservative posture that check exists for.
 *
 * The SDK carries a named permission profile instead of --sandbox. Every
 * profile includes the shared secret-read and person-only write refusals.
 * Write grants become additionalDirectories and profile workspace roots;
 * read grants add no authority, because the profile already permits reads
 * outside the workspace except for protected files.
 *
 * @param settings - Effective settings (per-send override → tracked → persisted → default)
 * @param cwd - Working directory for the turn, when known
 * @param writable - This turn's writable folders, already validated by
 *   {@link grantedWritableDirectories} (which throws DirectoryGrantError for an
 *   invalid grant set before any thread starts)
 */
export function projectThreadOptions(
  settings: SessionSettings,
  cwd: string | undefined,
  writable: readonly string[]
): ThreadOptions & { permissionProfile: string } {
  return {
    permissionProfile: codexPermissionProfile(settings),
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    ...(cwd !== undefined ? { workingDirectory: cwd } : {}),
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.effort !== undefined
      ? { modelReasoningEffort: EFFORT_TO_REASONING[settings.effort] }
      : {}),
    ...(writable.length > 0 ? { additionalDirectories: [...writable] } : {}),
  };
}
