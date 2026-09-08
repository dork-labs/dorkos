/** Configuration boundary for the pure runtime environment projection. */
import { configManager } from '../../core/config-manager.js';
import {
  projectRuntimeEnvironment,
  type EnvironmentRuntime,
  type EnvironmentPurpose,
} from './runtime-environment.js';

const CONFIG_RUNTIME = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
} as const;

/** Read only names from owner configuration, then project this launch's ambient environment. */
export function runtimeEnvironment(
  runtime: EnvironmentRuntime,
  purpose: EnvironmentPurpose,
  overrides?: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const inherit = runtimeInheritedNames(runtime);
  // eslint-disable-next-line no-restricted-syntax -- deliberate ambient-input boundary for the pure child-environment projection
  return projectRuntimeEnvironment({ parent: process.env, runtime, purpose, inherit, overrides });
}

/** Names-only policy identity also invalidates clients that capture env at construction. */
export function runtimeInheritedNames(runtime: EnvironmentRuntime): string[] {
  return configManager?.get('runtimes')?.environment?.inherit[CONFIG_RUNTIME[runtime]] ?? [];
}
