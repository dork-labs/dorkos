/**
 * Shared inputs for the session-defaults ladder tests: a minimal manifest, a
 * stored runtimes block, and the capability profiles each runtime declares.
 */
import type { RuntimeCapabilities, RuntimeSettingsCapability } from '@dorkos/shared/agent-runtime';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SessionSettings } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../../runtimes/opencode/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../../../runtimes/test-mode/runtime-constants.js';
import { resolveSessionDefaults } from '../../resolution/resolve-session-defaults.js';

/** The least manifest that validates, for the on-disk half of the ladder. */
export const BASE_MANIFEST: AgentManifest = {
  workspace: { mode: 'home' },
  id: 'agent-defaults-fixture',
  name: 'defaults-fixture',
  description: '',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  registeredAt: new Date().toISOString(),
  registeredBy: 'test',
  personaEnabled: true,
  mcpServers: [],
};

/** The stored `runtimes` block, with one section's fields replaced. */
export function runtimes(overrides: Partial<UserConfig['runtimes']> = {}): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, ...overrides };
}

/**
 * Every shipped runtime's own capability profile, keyed by type — the map the
 * server hands `describeExecutionDefaults`, built the way
 * `runtimeRegistry.getAllCapabilities()` builds it. `test-mode` belongs in it:
 * a registered runtime that declares no config section is the case the report
 * has to leave out, and it can only be left out if it was offered.
 */
export const REGISTERED_CAPABILITIES: Record<string, RuntimeCapabilities> = {
  'claude-code': CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  opencode: OPENCODE_CAPABILITIES,
  'test-mode': TEST_MODE_CAPABILITIES,
};

/**
 * A capability map from settings declarations alone, for the cases no shipped
 * adapter declares — an unknown section, or a runtime whose declared effort
 * support disagrees with the config shape it points at.
 *
 * @param declarations - Settings declaration per runtime type
 */
export function declaring(
  declarations: Record<string, RuntimeSettingsCapability>
): Record<string, RuntimeCapabilities> {
  return Object.fromEntries(
    Object.entries(declarations).map(([type, settings]) => [
      type,
      { ...TEST_MODE_CAPABILITIES, type, settings },
    ])
  );
}

/**
 * Resolve defaults the way the server does, with the runtime's own DECLARATIONS
 * travelling alongside its type.
 *
 * Which config section holds a runtime's defaults, and whether it takes an
 * effort at all, are that runtime's declarations now rather than lookups this
 * module keeps — so a test names a runtime and gets what that runtime really
 * declares, the same values `RuntimeRegistry` reads off it. Pass either field
 * explicitly to override it; their own rules are pinned in their own describe
 * blocks below.
 *
 * @param opts - Exactly {@link resolveSessionDefaults}'s options
 */
export function resolveForRuntime(
  opts: Parameters<typeof resolveSessionDefaults>[0]
): SessionSettings {
  const declared = REGISTERED_CAPABILITIES[opts.runtimeType]?.settings;
  return resolveSessionDefaults({
    configSection: declared?.configSection ?? null,
    supportsEffort: declared?.supportsEffort,
    ...opts,
  });
}
