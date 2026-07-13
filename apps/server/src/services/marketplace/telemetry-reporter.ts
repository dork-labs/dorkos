/**
 * Marketplace telemetry reporter — forwards install events to dorkos.ai.
 *
 * Registered once at server startup for the Tier 1 install channel
 * (`config.telemetry.install`, anonymous, opt-out, default true; ADR
 * 260713-143958). Uses the existing `registerTelemetryReporter` hook from
 * services/marketplace/telemetry-hook.ts.
 *
 * Privacy contract: see https://dorkos.ai/marketplace/privacy
 *
 * @module services/marketplace/telemetry-reporter
 */

import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import {
  registerTelemetryReporter,
  type InstallEvent,
  type TelemetryReporter,
} from './telemetry-hook.js';

const TELEMETRY_ENDPOINT = 'https://dorkos.ai/api/telemetry/install';

/**
 * The wire-format payload sent to the dorkos.ai telemetry endpoint.
 *
 * Mirrors {@link InstallEvent} (which is already PII-free by construction)
 * and adds two server-supplied fields: a stable per-machine `installId` and
 * the running `dorkosVersion`.
 */
export interface TelemetryPayload {
  packageName: string;
  marketplace: string;
  type: InstallEvent['type'];
  outcome: InstallEvent['outcome'];
  durationMs: number;
  errorCode?: string;
  installId: string;
  dorkosVersion: string;
}

/**
 * Register the dorkos.ai telemetry reporter for the lifetime of the server.
 *
 * No-op when `consent` is false. Reads or generates a stable install ID stored
 * in dorkHome — this is per-machine, not per-user, and never sent with PII.
 *
 * In debug mode (`DORKOS_TELEMETRY_DEBUG`), each install event's exact payload
 * is printed to stderr and the network call is skipped, so a power user can
 * audit the wire format for themselves.
 *
 * @param consent - The final send decision for the install channel. Must already
 *   fold in `config.telemetry.install`, the env kill switch (via
 *   `resolveTelemetryConsent`), and the Tier 1 notice-before-first-send gate
 *   (`hasTier1SendGate`) at the call site.
 * @param dorkHome - The resolved dorkHome path for storing the install ID.
 * @param dorkosVersion - The current DorkOS version string.
 * @param debug - When true, print each payload to stderr instead of sending it.
 */
export function registerDorkosCommunityTelemetry(
  consent: boolean,
  dorkHome: string,
  dorkosVersion: string,
  debug = false
): void {
  if (!consent) return;

  const reporter: TelemetryReporter = async (event) => {
    const installId = await getOrCreateInstanceId(dorkHome);
    const payload = buildPayload(event, installId, dorkosVersion);
    if (debug) {
      process.stderr.write(
        `[Telemetry] DORKOS_TELEMETRY_DEBUG: install event NOT sent. Would POST to ${TELEMETRY_ENDPOINT}:\n` +
          `${JSON.stringify(payload, null, 2)}\n`
      );
      return;
    }
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  registerTelemetryReporter(reporter);
}

/**
 * Build the wire-format payload from an {@link InstallEvent}.
 *
 * Strips nothing — the {@link InstallEvent} shape from `telemetry-hook` is
 * already PII-free by design. The `errorCode` field is only included when
 * present so successful events stay slim.
 *
 * @param event - The terminal install event reported by the installer.
 * @param installId - The stable per-machine UUID stored in dorkHome.
 * @param dorkosVersion - The current DorkOS version string.
 */
export function buildPayload(
  event: InstallEvent,
  installId: string,
  dorkosVersion: string
): TelemetryPayload {
  return {
    packageName: event.packageName,
    marketplace: event.marketplace,
    type: event.type,
    outcome: event.outcome,
    durationMs: event.durationMs,
    ...(event.errorCode !== undefined && { errorCode: event.errorCode }),
    installId,
    dorkosVersion,
  };
}
