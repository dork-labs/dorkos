/** Deliberate child environments. Filtering reduces accidental exposure; it is not an OS sandbox. */
import {
  RuntimeInheritedEnvNamesSchema,
  isReservedRuntimeEnvName,
} from '@dorkos/shared/config-schema';
import {
  BASELINE_ENV_NAMES,
  RUNTIME_ENV_PROFILES,
  CUSTOM_CLAUDE_MODES,
} from './runtime-environment-catalog.js';

/** Runtime whose auth profile and custom inheritance are selected. */
export type EnvironmentRuntime = 'claude-code' | 'codex' | 'opencode';
/** Helper processes do not need automatic model credentials. */
export type EnvironmentPurpose =
  | 'turn'
  | 'warmup'
  | 'auth-probe'
  | 'version-probe'
  | 'locator'
  | 'login'
  | 'provision'
  | 'process-inspection';
/** Explicit inputs keep ambient environment and configuration out of the pure projection. */
export interface RuntimeEnvironmentInput {
  parent: Readonly<Record<string, string | undefined>>;
  runtime: EnvironmentRuntime;
  purpose: EnvironmentPurpose;
  inherit?: readonly string[];
  overrides?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function authPurpose(purpose: EnvironmentPurpose): boolean {
  return ['turn', 'warmup', 'auth-probe', 'login'].includes(purpose);
}

function parentValue(input: RuntimeEnvironmentInput, name: string): string | undefined {
  if ((input.platform ?? process.platform) !== 'win32') return input.parent[name];
  const key = Object.keys(input.parent)
    .sort()
    .find((key) => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : input.parent[key];
}

function profileNames(input: RuntimeEnvironmentInput): readonly string[] {
  if (!authPurpose(input.purpose)) return [];
  if (input.runtime === 'codex') return RUNTIME_ENV_PROFILES.Codex;
  if (input.runtime === 'opencode') return RUNTIME_ENV_PROFILES.OpenCode;
  const names: string[] = [...RUNTIME_ENV_PROFILES['Claude common']];
  for (const [selector, profile] of [
    ['CLAUDE_CODE_USE_BEDROCK', 'Claude Bedrock'],
    ['CLAUDE_CODE_USE_VERTEX', 'Claude Vertex'],
    ['CLAUDE_CODE_USE_FOUNDRY', 'Claude Foundry'],
  ] as const) {
    if (!enabled(parentValue(input, selector))) continue;
    names.push(...RUNTIME_ENV_PROFILES[profile]);
    if (profile === 'Claude Bedrock') names.push(...RUNTIME_ENV_PROFILES['AWS chain']);
  }
  for (const name of CUSTOM_CLAUDE_MODES) {
    if (
      enabled(parentValue(input, name)) &&
      !input.inherit?.some((key) =>
        (input.platform ?? process.platform) === 'win32' ? key.toUpperCase() === name : key === name
      )
    ) {
      throw new Error(`Explicit runtime environment inheritance is required for ${name}.`);
    }
  }
  return names;
}

function overrideNames(input: RuntimeEnvironmentInput): Set<string> {
  const names = new Set<string>(BASELINE_ENV_NAMES);
  // Explicit account/data-root overrides are allowed for credential-free probes too.
  const paths = {
    'claude-code': ['CLAUDE_CONFIG_DIR'],
    codex: ['CODEX_HOME'],
    opencode: ['OPENCODE_DB', 'OPENCODE_CONFIG_DIR'],
  };
  for (const name of paths[input.runtime]) names.add(name);
  if (authPurpose(input.purpose)) for (const name of profileNames(input)) names.add(name);
  if (input.runtime === 'claude-code' && ['turn', 'warmup'].includes(input.purpose)) {
    names.add('CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS');
    // Keeps the task/todo tools on the model's surface — see the launch
    // resolver's own note for why the env var and not `allowedTools`.
    names.add('CLAUDE_CODE_ENABLE_TODO_TOOLS');
    if (input.purpose === 'turn') names.add('DORKOS_AGENT_TOKEN');
  }
  if (input.runtime === 'codex' && input.purpose === 'turn') names.add('DORKOS_AGENT_TOKEN');
  if (input.runtime === 'opencode' && input.purpose === 'turn') {
    names.add('OPENCODE_SERVER_PASSWORD');
    names.add('OPENCODE_CONFIG_CONTENT');
  }
  return names;
}

/** Project a complete environment, validate internal overrides, and never mutate or log inputs. */
export function projectRuntimeEnvironment(input: RuntimeEnvironmentInput): Record<string, string> {
  const inherit = RuntimeInheritedEnvNamesSchema.parse(input.inherit ?? []);
  const allowed = new Set<string>([...BASELINE_ENV_NAMES, ...profileNames(input), ...inherit]);
  const windows = (input.platform ?? process.platform) === 'win32';
  const upperAllowed = new Set([...allowed].map((name) => name.toUpperCase()));
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  // Sort resolves Windows PATH/Path collisions the same way Node does.
  for (const name of Object.keys(input.parent).sort()) {
    const upper = name.toUpperCase();
    if (isReservedRuntimeEnvName(name) || !(windows ? upperAllowed.has(upper) : allowed.has(name)))
      continue;
    if (windows && seen.has(upper)) continue;
    const value = input.parent[name];
    if (value !== undefined) {
      result[name] = value;
      seen.add(upper);
    }
  }
  const permitted = overrideNames(input);
  for (const [name, value] of Object.entries(input.overrides ?? {})) {
    if (!permitted.has(name)) throw new Error('Unsupported runtime environment override.');
    if (windows)
      for (const key of Object.keys(result))
        if (key.toUpperCase() === name.toUpperCase()) delete result[key];
    if (value === undefined) delete result[name];
    else result[name] = value;
  }
  return result;
}
