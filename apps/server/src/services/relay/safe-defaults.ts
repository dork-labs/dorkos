/**
 * Carrying a person's existing relay configuration forward when a default moves
 * to the safer side.
 *
 * ## Why this file exists
 *
 * DOR-604 changed two relay defaults, because absence was being read as consent
 * (ADR 260727-181825):
 *
 * - `SlackAdapterConfig.dmPolicy` — was `'open'`, so any member of the Slack
 *   workspace could DM an agent and drive a turn on the operator's machine.
 *   Now `'allowlist'`.
 * - `AdapterBinding.permissionMode` — was `'acceptEdits'`, so a binding nobody
 *   configured ran in a mode nobody chose. Now `'default'`, which prompts.
 *
 * Both were `.default(...)` values on a Zod schema, and both files
 * (`adapters.json`, `bindings.json`) are re-parsed through that schema on every
 * load. Moving the default alone would therefore reach back in time and change
 * what an ALREADY-INSTALLED integration does: a live Slack bot would stop
 * answering DMs, and a working binding would start prompting. That is a
 * functional regression for someone who never asked for one.
 *
 * ## The rule
 *
 * A new default applies to new configuration. An existing configuration keeps
 * the value it effectively had. So on load — before the schema's defaults get a
 * chance to fire — an entry that is missing one of these keys is stamped with
 * the value the old default gave it. After the first save the value is explicit
 * on disk, and this code never touches that entry again.
 *
 * Absence is the whole signal, and it is a sound one: both schemas materialize
 * these keys on write (`BindingStore.create` parses through
 * `CreateBindingRequestSchema` before saving; `saveAdapterConfig` writes back
 * what `loadAdapterConfig` parsed), so a missing key means the entry predates
 * the field — never that someone chose the value and it got dropped.
 *
 * ## This does not preserve the vulnerability silently
 *
 * A carried-forward `dmPolicy: 'open'` is still an open door. It is preserved so
 * the operator's integration keeps working, not because it is safe, and
 * `warnOnOpenDmPolicy` says so out loud at startup so the choice is theirs to
 * make knowingly rather than by omission.
 *
 * @module services/relay/safe-defaults
 */
import { logger } from '../../lib/logger.js';

/** What `AdapterBinding.permissionMode` resolved to before DOR-604. */
const LEGACY_BINDING_PERMISSION_MODE = 'acceptEdits';

/** What `SlackAdapterConfig.dmPolicy` resolved to before DOR-604. */
const LEGACY_SLACK_DM_POLICY = 'open';

/** Whether a value is a plain JSON object we can safely read keys from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stamp `permissionMode` onto stored bindings that predate the field, so they
 * keep the `'acceptEdits'` they effectively ran with instead of picking up the
 * new prompting default.
 *
 * Operates on the raw parsed JSON, before `AdapterBindingSchema` runs — once the
 * schema applies its default the old value is unrecoverable. Shape problems are
 * left alone for the schema to reject and report.
 *
 * @param raw - The parsed contents of `bindings.json`.
 * @returns The same structure with legacy entries stamped.
 */
export function carryForwardBindingDefaults(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.bindings)) return raw;

  let carried = 0;
  const bindings = raw.bindings.map((entry) => {
    if (!isRecord(entry) || 'permissionMode' in entry) return entry;
    carried++;
    return { ...entry, permissionMode: LEGACY_BINDING_PERMISSION_MODE };
  });

  if (carried > 0) {
    logger.info(
      `[Relay] Carried ${carried} pre-existing binding(s) forward at permissionMode ` +
        `'${LEGACY_BINDING_PERMISSION_MODE}'. New bindings prompt by default (DOR-604).`
    );
  }
  return { ...raw, bindings };
}

/**
 * Stamp `dmPolicy` onto stored Slack adapters that predate the field, so a live
 * integration keeps answering DMs instead of going silent the moment the default
 * moves to `'allowlist'`.
 *
 * Operates on the raw parsed JSON, before `AdaptersConfigFileSchema` runs, for
 * the same reason as {@link carryForwardBindingDefaults}.
 *
 * @param raw - The parsed contents of `adapters.json`.
 * @returns The same structure with legacy Slack entries stamped.
 */
export function carryForwardAdapterDefaults(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.adapters)) return raw;

  let carried = 0;
  const adapters = raw.adapters.map((entry) => {
    if (!isRecord(entry) || entry.type !== 'slack') return entry;
    const config = entry.config;
    if (!isRecord(config) || 'dmPolicy' in config) return entry;
    carried++;
    return { ...entry, config: { ...config, dmPolicy: LEGACY_SLACK_DM_POLICY } };
  });

  if (carried > 0) {
    logger.info(
      `[Relay] Carried ${carried} pre-existing Slack integration(s) forward at dmPolicy ` +
        `'${LEGACY_SLACK_DM_POLICY}'. New integrations use an allowlist (DOR-604).`
    );
  }
  return { ...raw, adapters };
}

/**
 * Tell the operator, once per load, that a Slack integration is reachable by
 * anyone in the workspace.
 *
 * `dmPolicy: 'open'` means any workspace member can DM the bot and start a turn
 * on this machine. That is a real choice someone may want, but it is not one to
 * make by accident, and a config carried forward from before DOR-604 made it by
 * omission. The warning names the integration so the fix is obvious.
 *
 * @param adapters - The loaded adapter configs.
 */
export function warnOnOpenDmPolicy(adapters: ReadonlyArray<unknown>): void {
  for (const entry of adapters) {
    if (!isRecord(entry) || entry.type !== 'slack' || entry.enabled === false) continue;
    const config = entry.config;
    if (!isRecord(config) || config.dmPolicy !== LEGACY_SLACK_DM_POLICY) continue;
    logger.warn(
      `[Relay] Slack integration '${String(entry.id)}' accepts direct messages from anyone in ` +
        `the workspace, and a direct message can start an agent turn on this machine. ` +
        `Set "DM Access" to "Allowlist only" to limit it to people you name.`
    );
  }
}
