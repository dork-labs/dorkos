/**
 * Environment kill switches and debug mode for outbound telemetry.
 *
 * DorkOS has several first-party outbound channels (marketplace install events,
 * the daily heartbeat, error reporting). Each is gated by its own config flag,
 * but an operator must also be able to force **every** channel off from the
 * environment, without editing config — the universal `DO_NOT_TRACK` convention
 * (see https://consoledonottrack.com / donottrack.sh) plus a scoped
 * `DORKOS_TELEMETRY_DISABLED` escape hatch.
 *
 * This module is the single source of truth for that logic so the server, the
 * CLI, and their tests all parse the flags identically. It is deliberately
 * pure: callers pass in an env-like record (`process.env` on the server via
 * `env.ts`, `process.env` directly in the CLI) and get booleans back. Precedence
 * is **env over config** — a kill switch always wins.
 *
 * A separate `DORKOS_TELEMETRY_DEBUG` flag makes the payload senders print the
 * exact JSON they would send to stderr instead of sending it, so a power user
 * can audit the wire format for themselves.
 *
 * @module telemetry-consent
 */

/**
 * Environment variables that force every outbound telemetry channel off,
 * regardless of config. `DO_NOT_TRACK` is the cross-tool universal convention;
 * `DORKOS_TELEMETRY_DISABLED` is the DorkOS-scoped equivalent.
 */
export const TELEMETRY_DISABLE_ENV_VARS = ['DO_NOT_TRACK', 'DORKOS_TELEMETRY_DISABLED'] as const;

/**
 * Environment variable that switches the payload senders into debug mode: they
 * print the exact JSON payload to stderr instead of sending it over the network.
 */
export const TELEMETRY_DEBUG_ENV_VAR = 'DORKOS_TELEMETRY_DEBUG';

/**
 * A minimal env record: the string-keyed values this module reads. Both
 * `process.env` (`NodeJS.ProcessEnv`) and a plain test object satisfy it.
 */
export type TelemetryEnv = Record<string, string | undefined>;

/**
 * Whether a flag's raw string value is "on". Follows the `donottrack.sh`
 * convention: `'1'` or `'true'` (case-insensitive, surrounding whitespace
 * trimmed) count as on; everything else — including `'0'`, `'false'`, the empty
 * string, and unset — counts as off.
 *
 * @param raw - The raw environment value, or `undefined` when unset.
 */
function isFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * Whether an environment kill switch (`DO_NOT_TRACK` or
 * `DORKOS_TELEMETRY_DISABLED`) forces all outbound telemetry off.
 *
 * @param env - The environment record to read (e.g. `process.env`).
 */
export function isTelemetryDisabledByEnv(env: TelemetryEnv): boolean {
  return TELEMETRY_DISABLE_ENV_VARS.some((name) => isFlagOn(env[name]));
}

/**
 * Whether `DORKOS_TELEMETRY_DEBUG` is on — the payload senders should print the
 * exact JSON payload to stderr instead of sending it.
 *
 * @param env - The environment record to read (e.g. `process.env`).
 */
export function isTelemetryDebugEnabled(env: TelemetryEnv): boolean {
  return isFlagOn(env[TELEMETRY_DEBUG_ENV_VAR]);
}

/**
 * Resolve the effective consent for one channel. An environment kill switch
 * beats config: when either disable var is on, the channel is off no matter what
 * config says. Otherwise the config value stands.
 *
 * @param configValue - The channel's config flag (e.g. `telemetry.heartbeat`).
 * @param env - The environment record to read (e.g. `process.env`).
 */
export function resolveTelemetryConsent(configValue: boolean, env: TelemetryEnv): boolean {
  if (isTelemetryDisabledByEnv(env)) return false;
  return configValue;
}

/**
 * The minimal telemetry-consent shape the Tier 1 send gate reads: whether the
 * user has answered a consent prompt, and the last DorkOS version whose first-run
 * notice this install saw.
 */
export interface Tier1GateConfig {
  /** `true` once the user has explicitly answered a consent prompt (either way). */
  userHasDecided: boolean;
  /** The version whose first-run notice was shown, or `null` if never shown. */
  lastPromptedVersion: string | null;
}

/**
 * Whether the notice-before-first-send gate is open for the Tier 1 opt-out
 * channels (heartbeat + install; ADR 260713-143958). Tier 1 defaults ON, but a
 * genuinely anonymous, opt-out channel may only send **after** the first-run
 * notice has been shown (the Homebrew ordering rule). The gate is open when the
 * user has explicitly decided (`userHasDecided === true`) OR the first-run notice
 * has already been recorded (`lastPromptedVersion !== null`).
 *
 * This is an ADDITIONAL requirement on top of each channel's config flag and the
 * env kill switches: an effective Tier 1 send is
 * `resolveTelemetryConsent(flag, env) && hasTier1SendGate(config)`. Error
 * reporting is opt-in and does NOT use this gate.
 *
 * Centralized here so every Tier 1 sender (heartbeat, install, and future usage
 * counters) evaluates the gate identically.
 *
 * @param config - The telemetry consent state (`config.telemetry`).
 */
export function hasTier1SendGate(config: Tier1GateConfig | undefined | null): boolean {
  if (config == null) return false;
  return config.userHasDecided === true || config.lastPromptedVersion !== null;
}

/** The three anonymous, first-party channels a person answers once for (ADR 260727-181825). */
export const TIER1_CHANNELS = ['install', 'heartbeat', 'usage'] as const;

/** One of {@link TIER1_CHANNELS}. */
export type Tier1Channel = (typeof TIER1_CHANNELS)[number];

/**
 * The stored telemetry shape these helpers read. Loose on purpose: it is read
 * straight from a settings file a person may have written by hand, so nothing
 * in it is trusted to be the type the schema says.
 */
export interface Tier1ConsentConfig {
  userHasDecided?: unknown;
  install?: unknown;
  heartbeat?: unknown;
  usage?: unknown;
}

/**
 * Whether one Tier 1 channel may send, read from the person's answer and never
 * from a migration having run (DOR-4400).
 *
 * The channel is on only when the person has answered (`userHasDecided` is
 * exactly `true`), its flag is exactly `true`, and no env kill switch is set.
 * Anything else, including stored `true` flags in a file nobody answered for,
 * reads as off. Every Tier 1 sender (marketplace installs, the heartbeat,
 * usage events) reads its consent through here.
 *
 * @param config - The stored telemetry block (`config.telemetry`), if any.
 * @param channel - Which channel is asking.
 * @param env - The environment record to read (e.g. `process.env`).
 * @returns True when the channel may send.
 */
export function resolveTier1ChannelConsent(
  config: Tier1ConsentConfig | undefined | null,
  channel: Tier1Channel,
  env: TelemetryEnv
): boolean {
  if (config == null || config.userHasDecided !== true) return false;
  return resolveTelemetryConsent(config[channel] === true, env);
}

/**
 * The telemetry block as it is in force, for anything that shows it to a
 * person: when nobody has answered, the three Tier 1 channels read off,
 * whatever the file says, so a switch never shows "on" for a channel that
 * sends nothing (DOR-4400). Every other field is passed through unchanged.
 *
 * @param config - The stored telemetry block.
 * @returns The same block, with the Tier 1 channels off when unanswered.
 */
export function effectiveTier1Telemetry<T extends Tier1ConsentConfig>(config: T): T {
  if (config.userHasDecided === true) return config;
  return { ...config, install: false, heartbeat: false, usage: false };
}
