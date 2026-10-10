/**
 * What remote access does by itself when the server starts (DOR-2086): which
 * kind may come back, and the person's own tunnel's autostart.
 *
 * ## The boot rule
 *
 * | `TUNNEL_ENABLED` | Saved choice                 | Own tunnel opens | Managed command stream reconnects |
 * | ---------------- | ---------------------------- | ---------------- | --------------------------------- |
 * | `true`           | anything                     | yes              | no                                |
 * | `false`          | anything                     | no               | no                                |
 * | unset            | managed (`cloud.remote.mode`) | no              | yes                               |
 * | unset            | managed, switch off, own on  | yes              | no                                |
 * | unset            | own tunnel on (`tunnel.enabled`) | yes          | no                                |
 * | unset            | nothing                      | no               | no                                |
 *
 * An explicit `TUNNEL_ENABLED=true` is someone choosing the person's own tunnel
 * for this process. An explicit `false` keeps both kinds from coming back on
 * their own. With it unset, a saved managed choice wins over an older saved
 * `tunnel.enabled=true`, which stays saved for when the person switches back.
 * A saved managed choice counts only while the `DORKOS_MANAGED_REMOTE` switch
 * is on: with it off, managed access does not exist, and the saved own tunnel
 * comes back as it did before.
 *
 * Managed access never OPENS at boot: the most boot does is reconnect the
 * command stream (when the computer is enrolled under the current link and
 * managed access is available), and only a Cloud `open` command opens, which
 * still runs `canExpose()`. The own tunnel's autostart checks `canExpose()`
 * first, as it always has. A person choosing a mode later is not bound by this
 * rule: it decides only what happens without anyone asking.
 *
 * `boot-matrix.test.ts` pins every row.
 *
 * @module services/core/remote/remote-boot
 */
import type { UserConfig } from '@dorkos/shared/config-schema';

import { logger, logError } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';
import { resolveTunnelSettings, type TunnelEnvInputs } from '../config/tunnel-settings.js';
import type { TunnelManager } from '../tunnel-manager.js';
import { readRemoteState } from './remote-state.js';

/** What the boot rule decides from. */
export interface RemoteBootInputs {
  /** `TUNNEL_ENABLED` as given to this process, or `undefined` when unset. */
  tunnelEnabledEnv: boolean | undefined;
  /** The saved `tunnel.enabled`. */
  storedTunnelEnabled: boolean;
  /**
   * Whether the saved `cloud.remote.mode` is `managed` AND the
   * `DORKOS_MANAGED_REMOTE` switch is on. With the switch off, a saved managed
   * choice is inert and must not hold back the saved own tunnel.
   */
  managedSelected: boolean;
}

/** What the boot rule decided. */
export interface RemoteBootPlan {
  /** Open the person's own tunnel now (still behind `canExpose()`). */
  ownTunnel: boolean;
  /** Reconnect the managed command stream (still behind every condition it checks). */
  reconnectManaged: boolean;
}

/**
 * The boot rule. Pure; see the module doc for the table.
 *
 * @param inputs - The environment flag and the saved choices.
 */
export function planRemoteBoot(inputs: RemoteBootInputs): RemoteBootPlan {
  if (inputs.tunnelEnabledEnv === true) return { ownTunnel: true, reconnectManaged: false };
  if (inputs.tunnelEnabledEnv === false) return { ownTunnel: false, reconnectManaged: false };
  if (inputs.managedSelected) return { ownTunnel: false, reconnectManaged: true };
  return { ownTunnel: inputs.storedTunnelEnabled, reconnectManaged: false };
}

/**
 * The boot rule over this process's environment and the saved config.
 *
 * @param env - The environment this process was started with: `TUNNEL_ENABLED`
 *   and the `DORKOS_MANAGED_REMOTE` switch.
 */
export function currentRemoteBootPlan(
  env: Pick<TunnelEnvInputs, 'TUNNEL_ENABLED'> & { DORKOS_MANAGED_REMOTE?: boolean }
): RemoteBootPlan {
  return planRemoteBoot({
    tunnelEnabledEnv: env.TUNNEL_ENABLED,
    storedTunnelEnabled: configManager.get('tunnel')?.enabled === true,
    managedSelected: env.DORKOS_MANAGED_REMOTE === true && readRemoteState().mode === 'managed',
  });
}

/** What {@link autostartOwnTunnel} touches. */
export interface OwnTunnelBootDeps {
  /** The environment this process was started with. */
  env: TunnelEnvInputs;
  /** The saved `tunnel` section. */
  stored: UserConfig['tunnel'] | undefined;
  /** The port to forward when `TUNNEL_PORT` is unset. */
  fallbackPort: number;
  /** The API port, to say in the log when a dev port is forwarded instead. */
  apiPort: number;
  /** The plan {@link planRemoteBoot} made. */
  plan: RemoteBootPlan;
  canExpose: () => boolean;
  tunnel: Pick<TunnelManager, 'start'>;
}

/**
 * Open the person's own tunnel at boot when the plan says so and exposure is
 * allowed. Never throws: a tunnel that will not open is logged, and the server
 * carries on without it.
 *
 * @param deps - The settings, the plan, the guard and the tunnel.
 */
export async function autostartOwnTunnel(deps: OwnTunnelBootDeps): Promise<void> {
  if (!deps.plan.ownTunnel) return;
  if (!deps.canExpose()) {
    logger.warn(
      '[Tunnel] Autostart skipped — exposing DorkOS requires a login. Enable login and ' +
        'create an owner account first (AUTH_REQUIRED_FOR_EXPOSURE).'
    );
    return;
  }
  const { config } = resolveTunnelSettings({
    env: deps.env,
    stored: deps.stored,
    fallbackPort: deps.fallbackPort,
  });
  try {
    const url = await deps.tunnel.start(config);
    const isDevPort = config.port !== deps.apiPort;
    logger.info('[Tunnel] ngrok tunnel active', {
      url,
      port: config.port,
      auth: config.basicAuth ? 'basic auth enabled' : 'none (open)',
      ...(isDevPort && { mode: `dev (Vite on :${config.port})` }),
    });
  } catch (err) {
    logger.warn(
      '[Tunnel] Failed to start ngrok tunnel — server continues without tunnel.',
      logError(err)
    );
  }
}
