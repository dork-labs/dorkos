/**
 * `dorkos telemetry <status|enable|disable>` — command logic + dispatcher
 * (DOR-312, ADR 260713-143958 Phase 1).
 *
 * A plain, honest control surface for the first-party outbound telemetry
 * channels: `install` (marketplace install events), `heartbeat` (the daily
 * anonymous ping), `usage` (named feature-usage events), and `errors` (crash
 * reports). `status` prints each channel's
 * effective state, flagging when an env kill switch (`DO_NOT_TRACK` /
 * `DORKOS_TELEMETRY_DISABLED`) overrides config. `enable`/`disable` write the
 * config flags (all channels, or one via `--channel`) and record the shared
 * `userHasDecided` gate so the first-run consent prompt never reappears.
 *
 * The command handlers (`runTelemetry*`) are server-free and side-effect-free
 * beyond the injected {@link ConfigStore} and IO, so they unit-test without a
 * running server. `runTelemetryDispatcher` wires the real config manager,
 * `process.env`, and the console; its server import is dynamic, so importing
 * this module for the pure handlers never pulls the server in.
 *
 * @module commands/telemetry
 */
import {
  isTelemetryDisabledByEnv,
  isTelemetryDebugEnabled,
  resolveTelemetryConsent,
  TELEMETRY_DISABLE_ENV_VARS,
} from '@dorkos/shared/telemetry-consent';
import type { ConfigStore } from '../../config-commands.js';

/** A user-facing telemetry channel name (as typed after `--channel`). */
export type TelemetryChannel = 'install' | 'heartbeat' | 'errors' | 'usage';

/** The channels a user can toggle. */
export const TELEMETRY_CHANNELS: readonly TelemetryChannel[] = [
  'install',
  'heartbeat',
  'errors',
  'usage',
];

/** Maps a channel name to its `telemetry.*` config key and a display label. */
const CHANNEL_META: Record<TelemetryChannel, { configKey: string; label: string }> = {
  install: { configKey: 'install', label: 'Install events' },
  heartbeat: { configKey: 'heartbeat', label: 'Daily heartbeat' },
  errors: { configKey: 'errorReporting', label: 'Crash reports' },
  usage: { configKey: 'usage', label: 'Feature usage' },
};

/** Command output routed somewhere (console in production, a buffer in tests). */
export interface TelemetryCommandIO {
  log: (message: string) => void;
  error: (message: string) => void;
}

/** Dependencies for the telemetry command handlers. */
export interface TelemetryDeps {
  /** Persistent config store (`~/.dork/config.json`). */
  store: ConfigStore;
  /** Environment record for kill-switch / debug detection (e.g. `process.env`). */
  env: Record<string, string | undefined>;
  /** Output sink. */
  io: TelemetryCommandIO;
}

/** Read a channel's raw config flag (defaults to `false` when unreadable). */
function readConfigFlag(store: ConfigStore, channel: TelemetryChannel): boolean {
  return store.getDot(`telemetry.${CHANNEL_META[channel].configKey}`) === true;
}

/**
 * Print the effective state of every channel, noting any env override and the
 * `userHasDecided` gate.
 *
 * @param deps - Config store, environment, and output sink.
 * @returns Process exit code (always `0`).
 */
export function runTelemetryStatus(deps: TelemetryDeps): number {
  const { store, env, io } = deps;
  const killed = isTelemetryDisabledByEnv(env);

  io.log('Telemetry status');
  io.log('');
  for (const channel of TELEMETRY_CHANNELS) {
    const configValue = readConfigFlag(store, channel);
    const effective = resolveTelemetryConsent(configValue, env);
    const state = effective ? 'on ' : 'off';
    const note = killed && configValue ? ' (forced off by env)' : ` (config: ${configValue})`;
    io.log(`  ${CHANNEL_META[channel].label.padEnd(18)}${state}${note}`);
  }
  io.log('');

  const decided = store.getDot('telemetry.userHasDecided') === true;
  io.log(
    decided
      ? 'You have made a telemetry choice, so the first-run prompt stays hidden.'
      : 'You have not chosen yet, so DorkOS will ask on first run.'
  );

  if (killed) {
    io.log('');
    io.log(
      `A kill switch is set (${TELEMETRY_DISABLE_ENV_VARS.join(' or ')}), so every channel is off no matter what config says.`
    );
  }
  if (isTelemetryDebugEnabled(env)) {
    io.log('');
    io.log(
      'Debug mode is on (DORKOS_TELEMETRY_DEBUG): payloads print to your terminal instead of being sent.'
    );
  }

  io.log('');
  io.log(`Config file: ${store.path}`);
  return 0;
}

/**
 * Write telemetry channel flags. Sets one channel (via `channel`) or all three,
 * then records `telemetry.userHasDecided = true`.
 *
 * @param deps - Config store, environment, and output sink.
 * @param enabled - `true` to opt in, `false` to opt out.
 * @param channel - A single channel to change, or `undefined` for all.
 * @returns Process exit code (always `0`).
 */
function writeChannels(deps: TelemetryDeps, enabled: boolean, channel?: TelemetryChannel): number {
  const { store, io } = deps;
  const targets = channel ? [channel] : TELEMETRY_CHANNELS;

  for (const target of targets) {
    store.setDot(`telemetry.${CHANNEL_META[target].configKey}`, enabled);
  }
  store.setDot('telemetry.userHasDecided', true);

  const verb = enabled ? 'Enabled' : 'Disabled';
  const scope = channel ? CHANNEL_META[channel].label.toLowerCase() : 'all telemetry channels';
  io.log(`${verb} ${scope}.`);

  if (enabled && isTelemetryDisabledByEnv(deps.env)) {
    io.log('');
    io.log(
      `Heads up: a kill switch is set (${TELEMETRY_DISABLE_ENV_VARS.join(' or ')}), so nothing will be sent until you unset it.`
    );
  }

  io.log('');
  return runTelemetryStatus(deps);
}

/**
 * Opt in: turn a channel (or all channels) on and record the decision.
 *
 * @param deps - Config store, environment, and output sink.
 * @param channel - A single channel, or `undefined` for all.
 */
export function runTelemetryEnable(deps: TelemetryDeps, channel?: TelemetryChannel): number {
  return writeChannels(deps, true, channel);
}

/**
 * Opt out: turn a channel (or all channels) off and record the decision.
 *
 * @param deps - Config store, environment, and output sink.
 * @param channel - A single channel, or `undefined` for all.
 */
export function runTelemetryDisable(deps: TelemetryDeps, channel?: TelemetryChannel): number {
  return writeChannels(deps, false, channel);
}

/** Help text rendered for `dorkos telemetry` with no subcommand or `--help`. */
export const HELP_TEXT = `
Usage: dorkos telemetry <subcommand>

See and control what anonymous data DorkOS sends. The anonymous heartbeat,
install counts, and feature-usage events are on by default and opt-out; crash
reports stay off until you turn them on. Nothing sends until DorkOS has shown you its first-run notice. Env
kill switches DO_NOT_TRACK and DORKOS_TELEMETRY_DISABLED force every channel off,
beating this config.

Subcommands:
  status                 Show each channel's state and any env override
  enable [--channel C]   Turn on all channels, or just one
  disable [--channel C]  Turn off all channels, or just one

Channels (C): install | heartbeat | errors | usage

Examples:
  dorkos telemetry status
  dorkos telemetry enable
  dorkos telemetry disable --channel heartbeat
`;

/** Command output routed to the console. */
const consoleIo: TelemetryCommandIO = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/**
 * Parse a `--channel <name>` / `--channel=<name>` flag out of the subcommand
 * args. Returns the channel, `undefined` when the flag is absent (meaning "all
 * channels"), or an `error` string for an unknown channel.
 */
function parseChannel(args: string[]): { channel?: TelemetryChannel; error?: string } {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--channel') {
      raw = args[i + 1];
      break;
    }
    if (arg.startsWith('--channel=')) {
      raw = arg.slice('--channel='.length);
      break;
    }
  }
  if (raw === undefined) return {};
  if ((TELEMETRY_CHANNELS as readonly string[]).includes(raw)) {
    return { channel: raw as TelemetryChannel };
  }
  return { error: `Unknown channel: ${raw}. Use one of: ${TELEMETRY_CHANNELS.join(', ')}` };
}

/**
 * Dispatch a `dorkos telemetry <subcommand>` invocation. Wires the real config
 * manager, `process.env`, and the console into the handlers above.
 *
 * @param dorkHome - The resolved `~/.dork` data directory (set by `cli.ts`).
 * @param subcommand - `status`, `enable`, `disable`; `undefined`/`--help`/`-h` prints help.
 * @param subArgs - The argv slice following the subcommand.
 * @returns The intended process exit code.
 */
export async function runTelemetryDispatcher(
  dorkHome: string,
  subcommand: string | undefined,
  subArgs: string[]
): Promise<number> {
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }

  try {
    const { initConfigManager } = await import('../../../server/services/core/config-manager.js');
    const store = initConfigManager(dorkHome) as unknown as ConfigStore;
    // The CLI resolves its environment imperatively (see the DORK_HOME
    // convention in cli.ts); read process.env directly at call time.
    // eslint-disable-next-line no-restricted-syntax -- call-time env resolution (CLI convention)
    const env = process.env;
    const deps = { store, env, io: consoleIo };

    if (subcommand === 'status') return runTelemetryStatus(deps);

    if (subcommand === 'enable' || subcommand === 'disable') {
      const { channel, error } = parseChannel(subArgs);
      if (error) {
        console.error(error);
        return 1;
      }
      return subcommand === 'enable'
        ? runTelemetryEnable(deps, channel)
        : runTelemetryDisable(deps, channel);
    }

    console.error(`Unknown telemetry subcommand: ${subcommand}`);
    console.error('Usage: dorkos telemetry <status|enable|disable>');
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
