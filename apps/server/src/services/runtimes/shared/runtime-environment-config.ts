/** Configuration boundary for the pure runtime environment projection. */
import { SESSION_GIT_CONFIG, withGitConfigEnv } from '@dorkos/shared/git-hardening';
import { isTelemetryDisabledByEnv } from '@dorkos/shared/telemetry-consent';
import { configManager } from '../../core/config-manager.js';
import { projectSetting } from '../../../lib/process/project-env-store.js';
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

/** The runtime kinds of {@link childEnvironment}: one per runtime, and the delegated sign-in. */
export type RuntimeChildKind = EnvironmentRuntime | 'runtime-login';

/** What a runtime child is for, besides sign-in, which is the `runtime-login` kind. */
export type RuntimeChildPurpose = Exclude<EnvironmentPurpose, 'login'>;

/**
 * The environment of every process an agent runtime starts: turns, warmups,
 * probes, locators, provisioning, and (as `runtime-login`) the delegated
 * sign-in. The other child kinds live in `@dorkos/shared/child-environment`;
 * a census test (`__tests__/child-env-census.test.ts`) fails a spawn that
 * builds its environment any other way.
 *
 * Reads the real environment only: the project `.env` file never enters
 * `process.env` (`@dorkos/shared/project-environment`), so no project value
 * reaches a runtime. Only names on the runtime's allow list pass, plus the
 * owner's configured inherit list. Every runtime child's git also gets
 * {@link SESSION_GIT_CONFIG} (DOR-2326), appended after any git settings the
 * environment already carries, so a folder shaped like a git directory cannot
 * run a program when an agent runs git in it. A person's own hooks are left
 * alone; `@dorkos/shared/git-hardening` says why. A turn also says which
 * runtime it is and that DorkOS hosts it ({@link flowIdentityEnv}), over anything
 * of the same name the owner chose to inherit (DOR-2405).
 *
 * @param kind - The runtime, or `runtime-login` for the delegated sign-in.
 * @param purposeOrRuntime - What the child is for (`turn` when unsaid); for
 *   `runtime-login`, which runtime signs in.
 * @param overrides - Values this launch sets, checked against the projection's override list.
 */
export function childEnvironment(
  kind: EnvironmentRuntime,
  purpose?: RuntimeChildPurpose,
  overrides?: Readonly<Record<string, string | undefined>>
): Record<string, string>;
export function childEnvironment(
  kind: 'runtime-login',
  runtime: EnvironmentRuntime,
  overrides?: Readonly<Record<string, string | undefined>>
): Record<string, string>;
export function childEnvironment(
  kind: RuntimeChildKind,
  purposeOrRuntime?: RuntimeChildPurpose | EnvironmentRuntime,
  overrides?: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const login = kind === 'runtime-login';
  const runtime = login ? (purposeOrRuntime as EnvironmentRuntime) : kind;
  const purpose: EnvironmentPurpose = login
    ? 'login'
    : ((purposeOrRuntime as RuntimeChildPurpose | undefined) ?? 'turn');
  return withGitConfigEnv(
    projectRuntimeEnvironment({
      // eslint-disable-next-line no-restricted-syntax -- deliberate ambient-input boundary: process.env holds the real environment only
      parent: process.env,
      runtime,
      purpose,
      inherit: runtimeInheritedNames(runtime),
      overrides: { ...overrides, ...flowIdentityEnv(runtime, purpose) },
      telemetryOff: isTelemetryDisabledByEnv({ DO_NOT_TRACK: projectSetting('DO_NOT_TRACK') }),
    }),
    SESSION_GIT_CONFIG
  );
}

/** Names-only policy identity also invalidates clients that capture env at construction. */
export function runtimeInheritedNames(runtime: EnvironmentRuntime): string[] {
  return configManager?.get('runtimes')?.environment?.inherit[CONFIG_RUNTIME[runtime]] ?? [];
}
