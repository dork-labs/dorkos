/**
 * The server's own reading of the link-telemetry opt-in: live config plus the
 * server env kill switches. Kept apart from `link-telemetry.ts`, which the
 * `dorkos cloud` CLI also imports and which stays free of the config singleton.
 *
 * @module services/core/auth/link-telemetry-config
 */
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { env } from '../../../env.js';
import { configManager } from '../config-manager.js';
import { resolveLinkTelemetryInstanceId } from './link-telemetry.js';

/**
 * Default telemetry-instance-id resolver backed by the live config + server env.
 * Returns the anonymous per-install id only when the operator opted into linking
 * analytics (`telemetry.linkAnalyticsToAccount`) and no env kill switch is set;
 * otherwise `undefined`, so the descriptor omits it.
 */
export function resolveConfiguredLinkTelemetryInstanceId(): Promise<string | undefined> {
  return resolveLinkTelemetryInstanceId({
    linkAnalyticsToAccount: configManager.get('telemetry')?.linkAnalyticsToAccount ?? false,
    dorkHome: resolveDorkHome(),
    env: {
      DO_NOT_TRACK: env.DO_NOT_TRACK,
      DORKOS_TELEMETRY_DISABLED: env.DORKOS_TELEMETRY_DISABLED,
    },
  });
}
