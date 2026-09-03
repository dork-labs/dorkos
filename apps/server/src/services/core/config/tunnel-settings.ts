/**
 * The one place that answers "should Remote Access be open, and with what
 * settings" — read at boot by `index.ts` and per request by
 * `routes/tunnel.ts`.
 *
 * It is one function because the two callers used to disagree on every input.
 * Boot read the environment and ignored the stored config, so a tunnel someone
 * turned on in the app never came back after a restart. The route read the
 * stored config and ignored `TUNNEL_AUTH`/`TUNNEL_DOMAIN`, so an operator who
 * exported a basic-auth pair and then pressed the button in the app got a public
 * tunnel with no password on it — while `GET /api/config`, which does read the
 * environment, reported that auth was on (DOR-1738).
 *
 * Pure, and separate from both callers, so the rule can be tested directly:
 * `index.ts` is a boot script and a rule buried in it is a rule nobody can
 * exercise.
 *
 * @module services/core/config/tunnel-settings
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { TunnelConfig } from '../tunnel-manager.js';

/**
 * The environment variables the tunnel is configured by.
 *
 * A structural subset of the server's parsed `env`, so a test can state five
 * values instead of building a whole environment, and so this module never
 * reaches for `process.env` itself.
 */
export interface TunnelEnvInputs {
  /**
   * `true`/`false` when someone set `TUNNEL_ENABLED`, `undefined` when nobody
   * did. The difference is the whole point — see {@link resolveTunnelSettings}.
   */
  TUNNEL_ENABLED?: boolean | undefined;
  /** `TUNNEL_PORT` — the port to forward, when it should not be where the app is served. */
  TUNNEL_PORT?: number | undefined;
  /** `TUNNEL_AUTH` — `user:pass` for the HTTP basic auth in front of the tunnel. */
  TUNNEL_AUTH?: string | undefined;
  /** `TUNNEL_DOMAIN` — a reserved ngrok domain to claim instead of an ephemeral one. */
  TUNNEL_DOMAIN?: string | undefined;
  /** `NGROK_AUTHTOKEN` — the ngrok account token. */
  NGROK_AUTHTOKEN?: string | undefined;
}

/** Everything {@link resolveTunnelSettings} decides from. */
export interface TunnelSettingsInput {
  /** The environment this process was started with. */
  env: TunnelEnvInputs;
  /** The `tunnel` section of `~/.dork/config.json`, if the config has one. */
  stored: UserConfig['tunnel'] | undefined;
  /**
   * The port to forward when no `TUNNEL_PORT` is set — where a browser reaches
   * the app on this machine (`getLocalCockpitPort`), which outside production is
   * the Vite dev server rather than the API port.
   */
  fallbackPort: number;
}

/** What {@link resolveTunnelSettings} decided. */
export interface ResolvedTunnelSettings {
  /**
   * Whether the tunnel should be open without anyone asking — the boot-time
   * question. A request to `POST /api/tunnel/start` is itself the asking, so
   * that route ignores this and reads {@link ResolvedTunnelSettings.config}.
   */
  enabled: boolean;
  /** What to hand the tunnel manager's `start()`. */
  config: TunnelConfig;
}

/**
 * Normalize an optional setting to `string | undefined`.
 *
 * The env half and the stored half spell "not set" differently — the env leaves
 * the variable out, the config schema stores `null` — and an empty string is a
 * third spelling of the same thing that neither type rules out. All three have to
 * arrive at ngrok as `undefined`: a `domain: ''` is a request to register the
 * empty domain, not a request for an ephemeral URL.
 */
function firstSet(fromEnv: string | undefined, fromConfig: string | null | undefined) {
  return fromEnv || fromConfig || undefined;
}

/**
 * Resolve the tunnel's settings from the environment and the stored config.
 *
 * **Environment first, stored config second, per field.** The environment is
 * what someone told THIS process on this launch; the config is what they last
 * told the app through its UI. That order also matches the CLI, which copies the
 * same config keys into the environment before the server boots
 * (`packages/cli/src/cli.ts`) — so for a CLI launch this function reads values
 * that are already in `env` and reaches the identical answer.
 *
 * **`TUNNEL_ENABLED` unset is not `TUNNEL_ENABLED=false`.** Unset means nobody
 * has said anything about this launch, so the stored preference decides — which
 * is what makes Remote Access survive a restart of the desktop app, whose shell
 * passes no `TUNNEL_*` variables at all. An explicit `false` is somebody saying
 * "not this process", and it beats a stored `true`: a tunnel is an exposure, so
 * the instruction that narrows it wins.
 *
 * This answers only "should it, and how". Whether it MAY — the exposure guard
 * (`canExpose()`), and on the route the caller bars — is decided at each call
 * site, unchanged.
 *
 * @param input - The environment, the stored config, and the port to fall back to.
 */
export function resolveTunnelSettings(input: TunnelSettingsInput): ResolvedTunnelSettings {
  const { env, stored, fallbackPort } = input;

  return {
    enabled: env.TUNNEL_ENABLED ?? stored?.enabled === true,
    config: {
      port: env.TUNNEL_PORT ?? fallbackPort,
      authtoken: firstSet(env.NGROK_AUTHTOKEN, stored?.authtoken),
      domain: firstSet(env.TUNNEL_DOMAIN, stored?.domain),
      basicAuth: firstSet(env.TUNNEL_AUTH, stored?.auth),
    },
  };
}
