/**
 * Resolve the anonymous telemetry instance id to thread through the device-link
 * descriptor, gated by the operator's opt-in (DOR-320, ADR 260713-143958
 * Phase 4).
 *
 * This is the single decision point that turns the dormant device-link analytics
 * merge on. It returns the app's anonymous per-install `instanceId` ONLY when the
 * operator has opted in (`telemetry.linkAnalyticsToAccount`) AND no environment
 * kill switch is set — reusing {@link resolveTelemetryConsent} so
 * `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED` suppress this channel exactly like
 * every other outbound telemetry channel (env beats config). Otherwise it returns
 * `undefined`, and the caller omits the id from the descriptor so the cloud never
 * aliases this install's analytics onto the account.
 *
 * Shared by the server's `CloudLinkManager` and the `dorkos cloud` CLI so both
 * link paths evaluate the opt-in identically. Kept out of the pure device-flow
 * HTTP client (`cloud-link-client.ts`) because it reads the on-disk per-install
 * id file via {@link getOrCreateInstanceId}.
 *
 * @module services/core/auth/link-telemetry
 */
import { resolveTelemetryConsent, type TelemetryEnv } from '@dorkos/shared/telemetry-consent';
import { getOrCreateInstanceId } from '../../../lib/instance-id.js';

/**
 * Resolve the telemetry instance id to include in the link descriptor, or
 * `undefined` when the operator has not opted in (or an env kill switch is set).
 *
 * @param args.linkAnalyticsToAccount - The `telemetry.linkAnalyticsToAccount`
 *   config flag (the explicit opt-in captured in the account-link flow).
 * @param args.dorkHome - The resolved dorkHome path (where the per-install id lives).
 * @param args.env - The env record to read the kill switches from (`process.env`
 *   in the CLI; the server's parsed `env` on the server).
 * @returns The anonymous per-install `instanceId`, or `undefined` to omit it.
 */
export async function resolveLinkTelemetryInstanceId(args: {
  linkAnalyticsToAccount: boolean;
  dorkHome: string;
  env: TelemetryEnv;
}): Promise<string | undefined> {
  // Env kill switch beats the opt-in: when either disable var is set,
  // resolveTelemetryConsent returns false no matter the flag.
  if (!resolveTelemetryConsent(args.linkAnalyticsToAccount, args.env)) return undefined;
  return getOrCreateInstanceId(args.dorkHome);
}
