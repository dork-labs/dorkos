/** Configuration boundary for the pure runtime environment projection. */
import { SESSION_GIT_CONFIG, withGitConfigEnv } from '@dorkos/shared/git-hardening';
import { configManager } from '../../core/config-manager.js';
import {
  flowIdentityEnv,
  projectRuntimeEnvironment,
  type EnvironmentRuntime,
  type EnvironmentPurpose,
} from './runtime-environment.js';

const CONFIG_RUNTIME = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
  doe: 'doe',
} as const;

/**
 * Read only names from owner configuration, then project this launch's
 * ambient environment. Every runtime child's git also gets
 * {@link SESSION_GIT_CONFIG} (DOR-2326), appended after any git settings the
 * environment already carries, so a folder shaped like a git directory cannot
 * run a program when an agent runs git in it. A person's own hooks are left
 * alone; `@dorkos/shared/git-hardening` says why. A turn also says which
 * runtime it is and that DorkOS hosts it ({@link flowIdentityEnv}), over anything
 * of the same name the owner chose to inherit (DOR-2405).
 */
export function runtimeEnvironment(
  runtime: EnvironmentRuntime,
  purpose: EnvironmentPurpose,
  overrides?: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const inherit = runtimeInheritedNames(runtime);
  return withGitConfigEnv(
    projectRuntimeEnvironment({
      // eslint-disable-next-line no-restricted-syntax -- deliberate ambient-input boundary for the pure child-environment projection
      parent: process.env,
      runtime,
      purpose,
      inherit,
      overrides: { ...overrides, ...flowIdentityEnv(runtime, purpose) },
    }),
    SESSION_GIT_CONFIG
  );
}

/** Names-only policy identity also invalidates clients that capture env at construction. */
export function runtimeInheritedNames(runtime: EnvironmentRuntime): string[] {
  return configManager?.get('runtimes')?.environment?.inherit[CONFIG_RUNTIME[runtime]] ?? [];
}
