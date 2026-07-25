/**
 * The disclosure allowlist behind the operator `config_get` / `config_patch`
 * snapshot — an explicit, per-field classification of the whole user config.
 *
 * ## Why an allowlist
 *
 * `config_get` carries `readOnlyCarveOut: true`, so on the default login-off
 * posture it answers on the external `/mcp` endpoint with **no credential at
 * all**. The snapshot it returns therefore has to be a deliberate projection.
 * It used to be "the entire `configManager.getAll()` minus four dot-paths"
 * (`SENSITIVE_CONFIG_KEYS`), which fails in one direction only: a new
 * secret-bearing field is exposed the moment it is added and nothing complains.
 * That failure already shipped once (`mcp.apiKey` reached this surface before it
 * joined the denylist).
 *
 * So the model is inverted here. {@link CONFIG_DISCLOSURE} classifies **every
 * leaf** of {@link UserConfigSchema} as `expose` or `withhold`, and
 * {@link projectDisclosedConfig} builds its output by copying only the `expose`
 * paths. A field nobody classified is absent from the snapshot (fail-closed) and
 * the drift guard in `__tests__/config-disclosure.test.ts` fails the build until
 * its author classifies it. Anything the stored file carries that the schema does
 * not describe (for example `conf`'s internal migration bookkeeping) is dropped
 * for free.
 *
 * ## What is withheld, and why only that
 *
 * Two classes, and nothing else:
 *
 * 1. **Secrets and the things that locate them.** The four
 *    `SENSITIVE_CONFIG_KEYS` values, plus every credential *reference*:
 *    `providers` and `runtimes.codex.credentialRef` hold `keychain:` / `env:` /
 *    `file:` references (ADR-0315). A reference is not a secret, but a
 *    `file:/Users/me/.dork/secrets/anthropic` tells an unauthenticated caller
 *    exactly which file to read, which is the same escalation as handing over the
 *    key. Each of these gets a boolean `…Configured` sibling instead of its
 *    value, so an agent can still see that a provider is wired up without
 *    learning where the material lives.
 * 2. **Linked-account identity.** `cloud.linkedAccountLabel` names the DorkOS
 *    account this install is linked to (often a person's email). No operator task
 *    needs it, and `cloud.instanceTokenConfigured` already answers "is this
 *    install linked".
 *
 * Absolute paths (`server.cwd`, `server.boundary`, `mesh.scanRoots`,
 * `workspace.rootPath`, `runtimes.*.binaryPath`, `relay.dataDir`,
 * `agents.defaultDirectory`, and the agent `projectPath`s inside `ui.sidebar`)
 * stay exposed **on purpose**. They are how the operator surface addresses work:
 * `update_agent` targets an agent by `cwd`, and an agent that cannot see its
 * boundary cannot tell what it is allowed to touch. Withholding them would also
 * buy no confidentiality, because the only posture where `config_get` answers
 * tokenlessly is login-off, and in that same posture the equally tokenless
 * `GET /api/config` already reports `workingDirectory`, `boundary`, `dorkHome`,
 * and `mesh.scanRoots`. The line this module holds is "nothing that is a
 * credential or points at one", not "no paths".
 *
 * @module services/core/operator/config-disclosure
 */
import { z } from 'zod';
import { UserConfigSchema } from '@dorkos/shared/config-schema';

/**
 * What an untrusted caller may learn about one config leaf.
 *
 * - `expose` — the stored value is returned verbatim.
 * - `withhold` — the value never leaves the server. Leaves listed in
 *   {@link PRESENCE_FLAG_PATHS} are replaced by a boolean `…Configured` sibling;
 *   the rest are simply absent.
 */
export type ConfigDisclosure = 'expose' | 'withhold';

/**
 * Every leaf of {@link UserConfigSchema}, classified. Keys are dot-paths and must
 * match the schema exactly in both directions — the drift guard asserts it, so
 * adding, renaming, or removing a config field fails the build until this table
 * is updated with a deliberate verdict.
 *
 * Ordered to mirror the schema so a reviewer can read the two side by side.
 */
export const CONFIG_DISCLOSURE = {
  version: 'expose',

  'server.port': 'expose',
  // Working directory + boundary: the operator surface's own frame of reference.
  'server.cwd': 'expose',
  'server.boundary': 'expose',
  'server.open': 'expose',

  'tunnel.enabled': 'expose',
  // The public hostname this instance answers on; `GET /api/config` already
  // reports the live tunnel URL in the same posture.
  'tunnel.domain': 'expose',
  'tunnel.authtoken': 'withhold',
  'tunnel.auth': 'withhold',

  'ui.theme': 'expose',
  'ui.dismissedUpgradeVersions': 'expose',
  'ui.sidebar.pinned': 'expose',
  'ui.sidebar.groups': 'expose',
  'ui.sidebar.ungroupedSortMode': 'expose',
  'ui.sidebar.ungroupedCollapsed': 'expose',
  'ui.sidebar.recentsCollapsed': 'expose',
  'ui.sidebar.groupsHintDismissed': 'expose',
  'ui.sidebar.muted': 'expose',
  'ui.sidebar.ungroupedDisplayFilter': 'expose',
  'ui.shapes.active': 'expose',
  'ui.shapes.agentDefaults': 'expose',
  'ui.shapes.autoFollowAgent': 'expose',
  'ui.statusBar.pins': 'expose',

  'logging.level': 'expose',
  'logging.maxLogSizeKb': 'expose',
  'logging.maxLogFiles': 'expose',

  'relay.enabled': 'expose',
  'relay.dataDir': 'expose',

  'scheduler.enabled': 'expose',
  'scheduler.maxConcurrentRuns': 'expose',
  'scheduler.timezone': 'expose',
  'scheduler.retentionCount': 'expose',

  'mesh.scanRoots': 'expose',

  'onboarding.completedSteps': 'expose',
  'onboarding.skippedSteps': 'expose',
  'onboarding.startedAt': 'expose',
  'onboarding.dismissedAt': 'expose',
  'onboarding.completedAt': 'expose',

  'tours.seen': 'expose',
  'tours.declined': 'expose',

  'agentContext.relayTools': 'expose',
  'agentContext.meshTools': 'expose',
  'agentContext.adapterTools': 'expose',
  'agentContext.tasksTools': 'expose',

  'uploads.maxFileSize': 'expose',
  'uploads.maxFiles': 'expose',
  'uploads.allowedTypes': 'expose',

  'agents.defaultDirectory': 'expose',
  'agents.defaultAgent': 'expose',

  'extensions.enabled': 'expose',
  'extensions.disabled': 'expose',

  'mcp.enabled': 'expose',
  'mcp.apiKey': 'withhold',
  'mcp.rateLimit.enabled': 'expose',
  'mcp.rateLimit.maxPerWindow': 'expose',
  'mcp.rateLimit.windowSecs': 'expose',

  'telemetry.userHasDecided': 'expose',
  'telemetry.install': 'expose',
  'telemetry.heartbeat': 'expose',
  'telemetry.errorReporting': 'expose',
  'telemetry.lastPromptedVersion': 'expose',
  'telemetry.usage': 'expose',
  'telemetry.linkAnalyticsToAccount': 'expose',
  'telemetry.aiMetadata': 'expose',

  'workspace.enabled': 'expose',
  'workspace.rootPath': 'expose',
  'workspace.portBase': 'expose',
  'workspace.portBlockSize': 'expose',
  'workspace.defaultProvider': 'expose',
  'workspace.retentionCap': 'expose',

  'harness.autoSync': 'expose',

  'workbench.defaultViewers': 'expose',
  'workbench.terminalGraceTtlMinutes': 'expose',
  'workbench.autoOpenDiff': 'expose',

  'runtimes.default': 'expose',
  'runtimes.opencode.enabled': 'expose',
  'runtimes.opencode.binaryPath': 'expose',
  'runtimes.opencode.port': 'expose',
  'runtimes.opencode.provider': 'expose',
  'runtimes.opencode.baseURL': 'expose',
  'runtimes.codex.enabled': 'expose',
  'runtimes.codex.binaryPath': 'expose',
  // A credential reference: `file:` names a plaintext key file, `env:` names the
  // variable, `keychain:` names the entry. Replaced by a presence flag.
  'runtimes.codex.credentialRef': 'withhold',

  'auth.enabled': 'expose',

  'cloud.instanceToken': 'withhold',
  'cloud.instanceName': 'expose',
  // Names the DorkOS account this install is linked to, often an email address.
  'cloud.linkedAccountLabel': 'withhold',

  // The per-provider credential-reference map. Replaced by `providersConfigured`,
  // the list of provider ids that have a reference.
  providers: 'withhold',
} as const satisfies Record<string, ConfigDisclosure>;

/**
 * Withheld leaves that are replaced by a boolean `<leafName>Configured` sibling,
 * so a caller can still tell whether the credential is set up without learning
 * anything about it. Every entry must be classified `withhold` above (asserted by
 * the drift guard).
 */
export const PRESENCE_FLAG_PATHS: readonly string[] = [
  'tunnel.authtoken',
  'tunnel.auth',
  'mcp.apiKey',
  'cloud.instanceToken',
  'runtimes.codex.credentialRef',
];

/** Read the value at a dot-path, or `undefined` if any segment is missing. */
function readAtPath(root: Record<string, unknown>, parts: readonly string[]): unknown {
  let node: unknown = root;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Write a value at a dot-path, creating plain-object parents as needed. */
function writeAtPath(
  root: Record<string, unknown>,
  parts: readonly string[],
  value: unknown
): void {
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/**
 * Project a raw user-config object down to what an untrusted caller may read.
 *
 * Copies exactly the {@link CONFIG_DISCLOSURE} `expose` paths that are present in
 * the input (a missing path stays missing rather than materializing a `null`),
 * then adds the derived presence fields: a boolean `…Configured` sibling for each
 * {@link PRESENCE_FLAG_PATHS} entry, and `providersConfigured` listing the
 * provider ids that have a credential reference.
 *
 * @param raw - The stored config object, straight from `ConfigManager.getAll()`.
 * @returns A fresh object safe to serialize to an unauthenticated caller and to
 *   land in a model's context or a session transcript.
 */
export function projectDisclosedConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [dotPath, verdict] of Object.entries(CONFIG_DISCLOSURE)) {
    if (verdict !== 'expose') continue;
    const parts = dotPath.split('.');
    const value = readAtPath(raw, parts);
    if (value === undefined) continue;
    writeAtPath(out, parts, structuredClone(value));
  }

  for (const dotPath of PRESENCE_FLAG_PATHS) {
    const parts = dotPath.split('.');
    const leaf = parts[parts.length - 1]!;
    const flagParts = [...parts.slice(0, -1), `${leaf}Configured`];
    const value = readAtPath(raw, parts);
    writeAtPath(out, flagParts, typeof value === 'string' && value.trim().length > 0);
  }

  const providers = raw.providers;
  out.providersConfigured =
    providers !== null && typeof providers === 'object' && !Array.isArray(providers)
      ? Object.keys(providers as Record<string, unknown>).sort()
      : [];

  return out;
}

/**
 * Every leaf dot-path of {@link UserConfigSchema}, derived from the schema itself
 * rather than hand-listed.
 *
 * Walks the generated JSON Schema (the same `z.toJSONSchema` bridge
 * `ConfigManager` uses for its `conf` validation) and treats any node without a
 * `properties` map as a leaf, so records (`providers`,
 * `workbench.defaultViewers`), arrays, and primitives all terminate the walk.
 * Only the drift guard calls this, so the cost is never paid at request time.
 *
 * @returns Leaf dot-paths in schema order.
 */
export function configSchemaLeafPaths(): string[] {
  const root = z.toJSONSchema(UserConfigSchema, { target: 'jsonSchema2019-09' });
  const walk = (node: unknown, prefix: string): string[] => {
    const properties =
      node !== null && typeof node === 'object'
        ? (node as { properties?: Record<string, unknown> }).properties
        : undefined;
    if (!properties) return [prefix];
    return Object.entries(properties).flatMap(([key, child]) =>
      walk(child, prefix ? `${prefix}.${key}` : key)
    );
  };
  return walk(root, '');
}
