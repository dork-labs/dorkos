/**
 * Pure resolution logic for whether an extension is enabled, and which config
 * deviation list a toggle should mutate.
 *
 * Both `enabled` and `disabled` record DEVIATIONS from each extension's default
 * state (the JetBrains `disabled_plugins.txt` model generalized to two
 * defaults): `enabled` lists default-off extensions the user turned on;
 * `disabled` lists default-on extensions the user turned off. Centralizing the
 * rule here keeps discovery (initial status) and the manager (toggle routing) in
 * lockstep.
 *
 * Pure module: no I/O, no `config-manager` imports.
 *
 * @module services/extensions/extension-enable-resolution
 */

/** Tier metadata for a bundled core extension (the canonical definition). */
export interface CoreExtensionInfo {
  /** Extension id (matches the staged directory name and `extension.json` id). */
  id: string;
  /** Whether this ships enabled — `manifest.defaultEnabled !== false`. */
  defaultEnabled: boolean;
  /** Whether the user may disable it — `manifest.canDisable !== false`. */
  canDisable: boolean;
}

/** The two deviation lists persisted under `config.extensions`. */
export interface ExtensionsConfig {
  /** Ids turned ON that default OFF (user/marketplace + default-off core). */
  enabled: string[];
  /** Ids turned OFF that default ON (default-on core). */
  disabled: string[];
}

/**
 * Whether an extension's baseline (pre-override) state is ON.
 *
 * Core extensions follow their declared `defaultEnabled`; everything else
 * (user/marketplace) defaults off.
 *
 * @param id - Extension id.
 * @param core - Core-extension tier metadata keyed by id.
 */
export function defaultsOn(id: string, core: Map<string, CoreExtensionInfo>): boolean {
  const info = core.get(id);
  return info ? info.defaultEnabled : false;
}

/**
 * Resolve whether an extension should be enabled given the user's deviation lists.
 *
 * A default-on extension is enabled unless its id is explicitly in `disabled`; a
 * default-off extension is enabled only if its id is explicitly in `enabled`. A
 * core extension shipped on upgrade is absent from both lists and therefore
 * resolves to its declared default — no migration needed for the common case.
 *
 * A LOCKED core extension (`canDisable: false`) is pinned to its default and
 * ignores both lists: a deviation recorded before the lock shipped (e.g.
 * Marketplace disabled while its toggle was still live, DOR-122) must not keep
 * a required extension off.
 *
 * @param id - Extension id.
 * @param config - The user's `{ enabled, disabled }` deviation lists.
 * @param core - Core-extension tier metadata keyed by id.
 */
export function isEnabled(
  id: string,
  config: ExtensionsConfig,
  core: Map<string, CoreExtensionInfo>
): boolean {
  const info = core.get(id);
  if (info && !info.canDisable) return info.defaultEnabled;
  return defaultsOn(id, core) ? !config.disabled.includes(id) : config.enabled.includes(id);
}

/**
 * Compute the next `{ enabled, disabled }` config after toggling one extension.
 *
 * Returns a NEW config object (never mutates the input). Routing follows the
 * deviation model: a default-on extension records its OFF state in `disabled`; a
 * default-off (or user/marketplace) extension records its ON state in `enabled`.
 * The id is first stripped from both lists, then re-added to at most one — so an
 * id is never duplicated and a non-deviating state is recorded in neither list.
 *
 * @param id - Extension id being toggled.
 * @param on - Target state (`true` = enable, `false` = disable).
 * @param config - The current `{ enabled, disabled }` deviation lists.
 * @param core - Core-extension tier metadata keyed by id.
 */
export function setEnabled(
  id: string,
  on: boolean,
  config: ExtensionsConfig,
  core: Map<string, CoreExtensionInfo>
): ExtensionsConfig {
  const enabled = config.enabled.filter((eid) => eid !== id);
  const disabled = config.disabled.filter((eid) => eid !== id);
  if (defaultsOn(id, core)) {
    // Default-on: the only deviation worth recording is OFF.
    if (!on) disabled.push(id);
  } else {
    // Default-off (and user/marketplace): the only deviation worth recording is ON.
    if (on) enabled.push(id);
  }
  return { enabled, disabled };
}
