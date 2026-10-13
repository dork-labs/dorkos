/**
 * The install ref: a short, anonymous tag the dorkos.ai install command can
 * carry into a fresh install, so a site visit can be joined to the first run it
 * led to (DOR-2862).
 *
 * Wire form, as typed after `--ref=` on the command line:
 *
 *     <token>[.<utm_source>[.<utm_campaign>]]
 *
 * - `token` is 12 random lowercase base-36 characters minted by the site for one
 *   copy of the install command. It names nothing: not a person, not a browser,
 *   not a machine. It only means "this install came from that copy".
 * - `utm_source` / `utm_campaign` are the visitor's first-touch campaign tags,
 *   shared by everyone who followed the same link. Either may be empty.
 *
 * The CLI records the ref once, in `<dorkHome>/install-ref.json`, and never
 * overwrites it (first touch wins). Recording it sends nothing. The server reads
 * it only to attach it to the `first_run_completed` usage event, which is sent
 * only when the person has turned feature-usage telemetry on.
 *
 * Node-only: the read and write helpers use `node:fs`.
 *
 * @module install-ref
 */
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { INSTALL_REF_TOKEN_PATTERN, INSTALL_REF_UTM_PATTERN } from './telemetry-events.js';

/** File name (under dorkHome) holding the recorded install ref. */
export const INSTALL_REF_FILENAME = 'install-ref.json';

/** The whole wire form, `<token>[.<source>[.<campaign>]]`. */
const WIRE_PATTERN = /^([a-z0-9]{12})(?:\.([a-z0-9_-]{0,32})(?:\.([a-z0-9_-]{0,32}))?)?$/;

/**
 * A campaign value shaped like a per-person id (16+ hex characters or 8+
 * digits). The site never writes one; a hand-edited ref that does keeps its
 * token but loses the tag. (An `@` cannot reach here: the wire pattern refuses it.)
 */
const PERSONAL_UTM = /[0-9a-f]{16,}|[0-9]{8,}/;

/** Keep a campaign tag only when it is present and cannot name a person. */
function keepUtm(value: string | undefined): string | undefined {
  return value && !PERSONAL_UTM.test(value) ? value : undefined;
}

/** A parsed install ref: the token plus the first-touch campaign tags, when present. */
export const InstallRefSchema = z
  .object({
    token: z.string().regex(INSTALL_REF_TOKEN_PATTERN),
    utmSource: z.string().regex(INSTALL_REF_UTM_PATTERN).optional(),
    utmCampaign: z.string().regex(INSTALL_REF_UTM_PATTERN).optional(),
  })
  .strict();

/** A parsed {@link InstallRefSchema} value. */
export type InstallRef = z.infer<typeof InstallRefSchema>;

/** The on-disk record: the ref plus when this install recorded it (never sent). */
const StoredInstallRefSchema = InstallRefSchema.extend({
  recordedAt: z.string().datetime(),
}).strict();

/**
 * Parse the wire form typed after `--ref=`. Returns `null` for anything that is
 * not exactly a ref, so a mistyped or tampered value is ignored rather than
 * stored. Case is folded to lowercase before matching.
 *
 * @param raw - The value as typed, e.g. `k3j4mnb8x2qa.hn.launch`.
 */
export function parseInstallRef(raw: string): InstallRef | null {
  const match = WIRE_PATTERN.exec(raw.trim().toLowerCase());
  if (!match) return null;
  const [, token] = match;
  const utmSource = keepUtm(match[2]);
  const utmCampaign = keepUtm(match[3]);
  return {
    token,
    ...(utmSource ? { utmSource } : {}),
    ...(utmCampaign ? { utmCampaign } : {}),
  };
}

/**
 * Record a ref in the data directory, once. A ref already on disk is kept, so
 * the first install command that ran on this machine is the one that counts.
 * Best-effort: an invalid value or a write the OS refuses is ignored, because a
 * marketing tag must never fail an install or a start.
 *
 * @param dorkHome - The resolved data directory.
 * @param raw - The value typed after `--ref=`.
 * @param now - Clock override (tests).
 * @returns `true` when this call wrote the file.
 */
export function recordInstallRef(dorkHome: string, raw: string, now: Date = new Date()): boolean {
  const ref = parseInstallRef(raw);
  if (!ref) return false;
  const filePath = path.join(dorkHome, INSTALL_REF_FILENAME);
  try {
    fs.mkdirSync(dorkHome, { recursive: true });
    // `wx` fails when the file exists: first touch wins without a read-then-write race.
    fs.writeFileSync(filePath, JSON.stringify({ ...ref, recordedAt: now.toISOString() }), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the recorded ref, or `null` when there is none or the file is not a
 * valid record. The `recordedAt` stamp stays on disk; only the ref is returned.
 *
 * @param dorkHome - The resolved data directory.
 */
export function readInstallRef(dorkHome: string): InstallRef | null {
  try {
    const raw = fs.readFileSync(path.join(dorkHome, INSTALL_REF_FILENAME), 'utf8');
    const parsed = StoredInstallRefSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { token, utmSource, utmCampaign } = parsed.data;
    return {
      token,
      ...(utmSource ? { utmSource } : {}),
      ...(utmCampaign ? { utmCampaign } : {}),
    };
  } catch {
    return null;
  }
}
