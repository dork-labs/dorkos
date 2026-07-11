/**
 * Stable anonymous instance identifier for opt-in telemetry.
 *
 * A single random UUID stored as one line of text in
 * `<dorkHome>/telemetry-install-id`. It identifies a single DorkOS
 * installation — not a user — so telemetry sinks can de-duplicate noisy
 * retries without any PII. Every opt-in channel that sends to dorkos.ai
 * (marketplace install events, the weekly heartbeat) shares this one id.
 *
 * The file name is kept as `telemetry-install-id` for backward compatibility:
 * marketplace install telemetry created it first, and reusing the same file
 * keeps a single stable id per machine across all channels.
 *
 * @module lib/instance-id
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** File name (under dorkHome) holding the anonymous per-install UUID. */
export const INSTANCE_ID_FILENAME = 'telemetry-install-id';

/**
 * Read the per-install UUID from disk, generating and persisting a new one on
 * first call.
 *
 * The id is **not** tied to the user — it identifies a single DorkOS
 * installation so a telemetry endpoint can de-duplicate retries without
 * storing any PII. Shared by every opt-in dorkos.ai channel.
 *
 * @param dorkHome - The resolved dorkHome path. Must be a real directory or a
 * path the server has permission to create.
 */
export async function getOrCreateInstanceId(dorkHome: string): Promise<string> {
  const filePath = path.join(dorkHome, INSTANCE_ID_FILENAME);
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    const trimmed = existing.trim();
    if (trimmed) return trimmed;
  } catch {
    // File missing or unreadable — fall through to generate a new id.
  }
  const id = randomUUID();
  await fs.mkdir(dorkHome, { recursive: true });
  await fs.writeFile(filePath, id, 'utf8');
  return id;
}
