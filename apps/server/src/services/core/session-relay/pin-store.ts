/**
 * What a computer keeps to reach its own hub over the session relay (ADR
 * 261015-042933 rules 4 and 5): the pin, and the computer's own signing key.
 *
 * - **The pin**: the hub's https origin, the hub's Ed25519 public key (taken
 *   from the hub itself at link time, never from DorkOS Cloud), this
 *   computer's id as the hub knows it, and the relay secret the hub keeps a
 *   hash of. Written only at this computer by its signed-in owner when the
 *   relay is turned on (B3); read here to dial (B2). A `viewer_open` command
 *   carries no address, so the computer dials only what is pinned here.
 * - **The computer key**: a long-lived Ed25519 key, made on first use, whose
 *   public half the hub pins for this computer. The computer's `finish` is
 *   signed with it, so a stolen relay secret cannot stand in for the computer.
 *
 * Both are files in `<data folder>/session-relay/`, mode `0600`, and nothing
 * else: no config field, no environment variable. The pin also carries the
 * owner's two switches, the level (Chat or Full control) and the pause, so
 * `PATCH /api/config` and the agents' config tool can never reach either. Reads follow symlinks, which
 * matters only to someone who can already write the data folder. Removing the
 * pin turns the relay off at once, with the network up or down (B3's "revoke
 * works offline").
 *
 * @module services/core/session-relay/pin-store
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { claimSecretText } from '@dorkos/shared/secret-file';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import { RelayPinnedHubKeySchema } from '@dorkos/shared/session-relay';
import {
  RelayLinkComputerNameSchema,
  SessionRelayLevelSchema,
} from '@dorkos/shared/session-relay-link';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { approvalKeysPath } from './approval-key-store.js';
import { pinnableKey, signingKeyFromPem } from './channel.js';

/** The folder the relay's files live in, inside the data folder. */
const FOLDER = 'session-relay';
const PIN_FILE = 'pin.json';
const KEY_FILE = 'computer-key.pem';
const FILE_MODE = 0o600;

/**
 * A pin, as stored. Format 2 added the level, the pause, the name and the hub
 * owner's account; format 1 was never written by a released build, so a pin in
 * it reads as no pin at all and the owner links again.
 */
export const RelayPinSchema = z.strictObject({
  /** The store's own format, so a later release can read an older pin. */
  v: z.literal(2),
  /** This computer's id as its hub knows it. */
  computerId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.:-]+$/),
  /** The hub's origin: https, a host, an optional port, nothing else. */
  hubOrigin: z
    .string()
    .max(256)
    .refine(isHttpsOrigin, 'the hub origin must be a bare https origin'),
  /** The hub's Ed25519 public key, raw 32 bytes base64url. */
  hubKey: RelayPinnedHubKeySchema,
  /** The relay secret this computer presents on the dial; the hub keeps a hash. */
  relaySecret: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/),
  /** When the owner pinned it (ISO 8601). */
  pinnedAt: z.string().datetime(),
  /** The name this computer linked with, as the hub shows it. */
  computerName: RelayLinkComputerNameSchema,
  /**
   * What the web may do here. Only the owner at this computer raises it. The
   * relay serves both alike today: every relayed turn is held to Chat.
   */
  level: SessionRelayLevelSchema.default('chat'),
  /** The owner's away switch: a paused pin is never dialed. */
  paused: z.boolean().default(false),
  /** The issuer of the hub owner's account, when the hub named one. */
  issuer: z.string().min(1).max(512).optional(),
  /** The hub owner's account id at {@link RelayPinSchema} `issuer`, when named. */
  accountId: z.string().min(1).max(128).optional(),
});

/** See {@link RelayPinSchema}. */
export type RelayPin = z.infer<typeof RelayPinSchema>;

/** A pin as a writer hands it over: the level and the pause may be left to their defaults. */
export type RelayPinInput = z.input<typeof RelayPinSchema>;

/** Whether a string is exactly an https origin: scheme, host, optional port. */
function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

function folder(dorkHome: string): string {
  return path.join(dorkHome, FOLDER);
}

/**
 * The pin, or `null` when there is none or it cannot be read. A pin that does
 * not parse is never dialed: the relay stays off and the owner re-links.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function readRelayPin(dorkHome: string = resolveDorkHome()): RelayPin | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(folder(dorkHome), PIN_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = RelayPinSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through to the warning below.
  }
  logger.warn('[SessionRelay] The relay pin could not be read, so the relay stays off');
  return null;
}

/**
 * Save the pin. Only the owner's own turn-on at this computer may call this
 * (B3); nothing reachable over the relay, a tunnel or Cloud does.
 *
 * @param pin - The pin to keep.
 * @param dorkHome - The data folder; defaults to the live one.
 */
export async function writeRelayPin(
  pin: RelayPinInput,
  dorkHome: string = resolveDorkHome()
): Promise<void> {
  const checked = RelayPinSchema.parse(pin);
  await writeFileAtomic(path.join(folder(dorkHome), PIN_FILE), JSON.stringify(checked), {
    mode: FILE_MODE,
  });
}

/** The tail of the queue every pin change waits in. */
let pinQueue: Promise<unknown> = Promise.resolve();

/**
 * Run one change to the pin after every change before it has finished, so
 * two can never interleave: a resume racing an unlink cannot bring the pin
 * back, and two links cannot both pass "not linked yet". Every writer of the
 * pin (link, level, pause, resume, unlink) goes through here, and checks the
 * pin again inside `change`, never before it.
 *
 * @param change - The change; it reads the pin itself.
 * @returns What `change` returned.
 */
export function withRelayPinLock<T>(change: () => T | Promise<T>): Promise<T> {
  const run = pinQueue.then(change, change);
  // The queue goes on whatever this change came to.
  pinQueue = run.catch(() => undefined);
  return run;
}

/**
 * Change the owner's switches on the pin there is, atomically as a whole file.
 *
 * @param patch - The level, the pause, or both.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns The pin as now stored, or `null` when there is none to change.
 */
export async function updateRelayPin(
  patch: Partial<Pick<RelayPin, 'level' | 'paused'>>,
  dorkHome: string = resolveDorkHome()
): Promise<RelayPin | null> {
  const pin = readRelayPin(dorkHome);
  if (!pin) return null;
  const next = RelayPinSchema.parse({ ...pin, ...patch });
  await writeRelayPin(next, dorkHome);
  return next;
}

/**
 * Forget the pin: the relay is off from this moment, whether or not the
 * network is up. The approvals passkeys go with it, so a hub linked later
 * never inherits them. The computer key stays, so linking again keeps its
 * identity.
 * The caller passes the live dialer's close (`closeSessionRelay`), so an open
 * connection ends at once as well; the dialer also rechecks the pin on every
 * viewer report.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 * @param onCleared - Called once the pin is gone, to close an open connection.
 */
export function clearRelayPin(
  dorkHome: string = resolveDorkHome(),
  onCleared: () => void = () => undefined
): void {
  fs.rmSync(path.join(folder(dorkHome), PIN_FILE), { force: true });
  fs.rmSync(approvalKeysPath(dorkHome), { force: true });
  // An open connection ends now too, not only the next dial.
  onCleared();
}

/** The key, read once per data folder per process. */
const keyCache = new Map<string, KeyObject>();

/**
 * This computer's long-lived Ed25519 signing key, made on first use. Two
 * processes reaching a fresh folder together settle on one key.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function computerSigningKey(dorkHome: string = resolveDorkHome()): KeyObject {
  const cached = keyCache.get(dorkHome);
  if (cached) return cached;
  const file = path.join(folder(dorkHome), KEY_FILE);
  let pem: string;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch {
    // None yet: mint one, and settle on whichever another process wrote first.
    const { privateKey } = generateKeyPairSync('ed25519');
    const minted = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    pem = claimSecretText(file, minted, FILE_MODE).value;
  }
  const key = signingKeyFromPem(pem);
  keyCache.set(dorkHome, key);
  return key;
}

/**
 * This computer's public key, as its hub pins it at link time.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function computerPublicKey(dorkHome: string = resolveDorkHome()): string {
  return pinnableKey(computerSigningKey(dorkHome));
}
