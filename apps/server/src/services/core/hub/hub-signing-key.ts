/**
 * A hub's own Ed25519 signing key (DOR-2934, for the session relay, B1/B2).
 *
 * A person's Mac pins this key when it pairs with their hub, and the hub
 * signs each relay handshake with it, so the Mac knows it is talking to its
 * own hub and not to anything that sits between them, Cloud included.
 *
 * - **Made once**, just before the hub pins its first owner: never while
 *   pooled, so a hub nobody owns holds no key. It is never replaced after
 *   that, not even when the file is lost: a new key would break every Mac
 *   that pinned the old one, so such a hub refuses instead
 *   (`hub-assignment-sync.ts`).
 * - **Signs only while the hub serves**: an ended or refused hub signs
 *   nothing.
 * - **The private half** stays in `<dorkHome>/hub-signing-key.pem`, readable
 *   by this user only, written atomically. Never in the environment or the
 *   config, never logged, never sent anywhere.
 * - **The public half**, base64url of the raw 32 bytes, goes to Cloud with
 *   each confirmation, so Cloud can hand it to a Mac at pairing.
 * - **It signs relay transcripts and nothing else**: data that does not start
 *   with the relay's label line is refused, so a signature from it means
 *   nothing anywhere else.
 *
 * A person's own computer has no hub key; both readers throw there.
 *
 * @module services/core/hub/hub-signing-key
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';

import { currentServerRole } from '../../../lib/server-role.js';
import { hubServingState } from './hub-serving.js';

/** The file the private half lives in, under the data directory. */
export const HUB_SIGNING_KEY_FILE = 'hub-signing-key.pem';

/**
 * The first line of every session relay transcript (`dorkos-session-relay/v1`
 * in `@dorkos/shared`): the only thing this key signs.
 */
export const HUB_KEY_SIGNS_ONLY = 'dorkos-session-relay/v1\n';

/** The loaded key: its private half, and its public half as Cloud and a Mac see it. */
let loaded: { privateKey: KeyObject; publicKey: string } | null = null;

/** The public half of a private key: base64url of the raw 32 bytes. */
function publicHalf(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('The hub signing key has no public half.');
  return jwk.x;
}

/**
 * Load the hub's key from disk, when there is one. Called at boot, so a hub
 * that restarts signs again before its next confirmation.
 *
 * @param dorkHome - The DorkOS data directory.
 * @returns Whether a key was loaded.
 */
export function loadHubSigningKey(dorkHome: string): boolean {
  let pem: string;
  try {
    pem = fs.readFileSync(path.join(dorkHome, HUB_SIGNING_KEY_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The hub signing key file does not hold an Ed25519 key.');
  }
  loaded = { privateKey, publicKey: publicHalf(privateKey) };
  return true;
}

/**
 * The hub's public key, loading it from disk, or making the pair when there is
 * none and `mayCreate`. Called just before the hub confirms an assignment.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param mayCreate - Whether a missing key may be made: only before the hub
 *   pins its first owner.
 * @returns The public key, or `null` when there is none and it may not make one.
 */
export function ensureHubSigningKey(dorkHome: string, mayCreate = true): string | null {
  if (loaded) return loaded.publicKey;
  if (loadHubSigningKey(dorkHome)) return loaded!.publicKey;
  if (!mayCreate) return null;
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  fs.mkdirSync(dorkHome, { recursive: true });
  const file = path.join(dorkHome, HUB_SIGNING_KEY_FILE);
  // A write a crash cut short leaves a partial file behind; it is never used.
  for (const name of fs.readdirSync(dorkHome)) {
    if (name.startsWith(`${HUB_SIGNING_KEY_FILE}.`) && name.endsWith('.tmp')) {
      fs.rmSync(path.join(dorkHome, name), { force: true });
    }
  }
  const partial = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(partial, 'w', 0o600);
  try {
    fs.writeFileSync(fd, pem);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    // A hard link fails if a key is already there, so it is never replaced.
    fs.linkSync(partial, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    fs.rmSync(partial, { force: true });
    loadHubSigningKey(dorkHome);
    return loaded!.publicKey;
  }
  fs.rmSync(partial, { force: true });
  syncDirectory(dorkHome);
  loaded = { privateKey, publicKey: publicHalf(privateKey) };
  return loaded.publicKey;
}

/** Flush a directory's entries to disk, so a new file survives a power cut. */
function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The loaded key, or a throw that says why there is none. */
function requireKey(): { privateKey: KeyObject; publicKey: string } {
  if (currentServerRole() !== 'hub') throw new Error('Only a hub has a hub signing key.');
  if (!loaded) throw new Error('This hub has no signing key yet: it has not confirmed an owner.');
  if (hubServingState().state !== 'serving')
    throw new Error('This hub does not serve anybody now.');
  return loaded;
}

/**
 * The hub's public key: base64url of the raw 32 bytes (43 characters).
 *
 * @throws On a person's own computer, on a hub with no key yet, or on a
 *   hub that does not serve anybody now.
 */
export function hubSigningPublicKey(): string {
  return requireKey().publicKey;
}

/**
 * Sign a session relay transcript with the hub's key.
 *
 * @param data - The transcript's exact bytes; must start with
 *   {@link HUB_KEY_SIGNS_ONLY}.
 * @returns The 64-byte Ed25519 signature.
 * @throws On a person's own computer, on a hub with no key yet, on a hub
 *   that does not serve anybody now, or for data that is not a relay
 *   transcript.
 */
export function signWithHubKey(data: Uint8Array): Buffer {
  const { privateKey } = requireKey();
  const label = Buffer.from(HUB_KEY_SIGNS_ONLY, 'utf8');
  if (data.length < label.length || !Buffer.from(data.subarray(0, label.length)).equals(label)) {
    throw new Error('The hub signing key signs session relay transcripts only.');
  }
  return sign(null, data, privateKey);
}

/**
 * Forget the loaded key. Tests only.
 *
 * @internal
 */
export function resetHubSigningKeyForTests(): void {
  loaded = null;
}
