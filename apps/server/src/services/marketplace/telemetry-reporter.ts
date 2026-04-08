/**
 * Marketplace telemetry reporter — forwards install events to dorkos.ai.
 *
 * Registered once at server startup when `config.telemetry.enabled === true`.
 * Uses the existing `registerTelemetryReporter` hook from
 * services/marketplace/telemetry-hook.ts.
 *
 * Privacy contract: see https://dorkos.ai/marketplace/privacy
 *
 * @module services/marketplace/telemetry-reporter
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  registerTelemetryReporter,
  type InstallEvent,
  type TelemetryReporter,
} from './telemetry-hook.js';

const TELEMETRY_ENDPOINT = 'https://dorkos.ai/api/telemetry/install';
const INSTALL_ID_FILENAME = 'telemetry-install-id';

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
 * @param consent - Whether the user has opted in via `config.telemetry.enabled`.
 * @param dorkHome - The resolved dorkHome path for storing the install ID.
 * @param dorkosVersion - The current DorkOS version string.
 */
export function registerDorkosCommunityTelemetry(
  consent: boolean,
  dorkHome: string,
  dorkosVersion: string
): void {
  if (!consent) return;

  const reporter: TelemetryReporter = async (event) => {
    const installId = await getOrCreateInstallId(dorkHome);
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPayload(event, installId, dorkosVersion)),
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

/**
 * Read the per-install UUID from disk, generating a new one on first call.
 *
 * The ID is stored as a single line of text in
 * `<dorkHome>/telemetry-install-id`. It is **not** tied to the user — it
 * identifies a single DorkOS installation so the marketplace endpoint can
 * de-duplicate noisy retries without storing PII.
 *
 * @param dorkHome - The resolved dorkHome path. Must be a real directory or
 * a path the server has permission to create.
 * @internal Exported for testing.
 */
export async function getOrCreateInstallId(dorkHome: string): Promise<string> {
  const filePath = path.join(dorkHome, INSTALL_ID_FILENAME);
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    const trimmed = existing.trim();
    if (trimmed) return trimmed;
  } catch {
    // File missing or unreadable — fall through to generate a new ID.
  }
  const id = randomUUID();
  await fs.mkdir(dorkHome, { recursive: true });
  await fs.writeFile(filePath, id, 'utf8');
  return id;
}
