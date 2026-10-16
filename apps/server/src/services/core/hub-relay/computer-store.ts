/**
 * What a hub knows about each computer it serves over the session relay (ADR
 * 261015-042933 rules 4 and 5, spec `everything-is-a-space` step B1): the
 * computer's id, a hash of its relay secret, and the Ed25519 public key the
 * computer's `finish` must be signed with.
 *
 * The secret itself is never kept here, only its SHA-256, so reading this file
 * is not enough to dial in as a computer; and the pinned key means a stolen
 * secret is not enough either. Records are written only by the linking flow
 * (step B3, through `linkComputer` in this folder's `index.ts`, which also
 * closes a replaced computer's live connection); nothing reachable over the
 * relay writes here.
 *
 * One owner-only (`0600`) JSON file in an owner-only (`0700`) folder,
 * `<data folder>/hub-relay/computers.json`, written atomically. The parsed list
 * is kept in memory until this process writes the file or its modification
 * time or size changes, so a dial does not re-read it. A file that does not parse reads as no computers, so a
 * damaged file refuses every dial rather than admitting one.
 *
 * @module services/core/hub-relay/computer-store
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { withFileLock } from '@dorkos/shared/atomic-write';
import { RelayPinnedHubKeySchema } from '@dorkos/shared/session-relay';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';

const FOLDER = 'hub-relay';
const FILE = 'computers.json';
const FILE_MODE = 0o600;
const FOLDER_MODE = 0o700;

/** Most computers one hub serves. Linking one more is refused. */
export const HUB_RELAY_MAX_COMPUTERS = 32;

/** Base64url of exactly 32 bytes, unpadded: a SHA-256 or a raw Ed25519 key. */
const Base64url32Schema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/** One linked computer, as stored. */
export const LinkedComputerSchema = z.strictObject({
  /** The record's own format, so a later release can read an older one. */
  v: z.literal(1),
  /** The computer's id, as its `hello` names it. */
  computerId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.:-]+$/),
  /** SHA-256 of the computer's relay secret, base64url. Never the secret. */
  secretHash: Base64url32Schema,
  /** The computer's Ed25519 public key, raw 32 bytes base64url (`pinnableKey`). */
  computerKey: RelayPinnedHubKeySchema,
  /** When it was linked (ISO 8601). */
  linkedAt: z.string().datetime(),
});

/** See {@link LinkedComputerSchema}. */
export type LinkedComputer = z.infer<typeof LinkedComputerSchema>;

const FileSchema = z.array(LinkedComputerSchema).max(HUB_RELAY_MAX_COMPUTERS);

/** What the linking flow hands {@link linkComputer}. */
export type LinkComputerInput = Pick<LinkedComputer, 'computerId' | 'secretHash' | 'computerKey'>;

function filePath(dorkHome: string): string {
  return path.join(dorkHome, FOLDER, FILE);
}

/** The parsed list per data folder, with the file stamp it was read at. */
const cache = new Map<string, { stamp: string; computers: LinkedComputer[] }>();

/** Make the folder owner-only, whether it is new or already there. */
function ensureFolder(dorkHome: string): void {
  const dir = path.join(dorkHome, FOLDER);
  fs.mkdirSync(dir, { recursive: true, mode: FOLDER_MODE });
  fs.chmodSync(dir, FOLDER_MODE);
}

/**
 * Which part of the file failed to parse, naming a record by its position and
 * never quoting a value, so the log carries no id, hash or key.
 */
function describeFailure(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown';
  if (issue.path.length === 0) {
    return issue.code === 'too_big' ? 'too many computers' : 'not a list of computers';
  }
  const field = issue.path[1];
  return `computer ${String(issue.path[0])}${field === undefined ? '' : ` (${String(field)})`}`;
}

/**
 * The hash a hub keeps of a relay secret: SHA-256, base64url. The secret is
 * 32 random bytes, so a plain hash is enough; nothing to stretch.
 *
 * @param secret - The relay secret as the computer presents it.
 */
export function relaySecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/**
 * Every computer this hub serves, or none when the file is missing or does
 * not parse.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function readLinkedComputers(dorkHome: string = resolveDorkHome()): LinkedComputer[] {
  const file = filePath(dorkHome);
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    cache.delete(dorkHome);
    return [];
  }
  const cached = cache.get(dorkHome);
  if (cached?.stamp === stamp) return [...cached.computers];
  const computers = parseFile(file);
  cache.set(dorkHome, { stamp, computers });
  return [...computers];
}

/** Read and check the file; anything wrong reads as no computers. */
function parseFile(file: string): LinkedComputer[] {
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    logger.warn('[HubRelay] The linked computers could not be read, so none can connect', {
      failed: 'not JSON',
    });
    return [];
  }
  const parsed = FileSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  logger.warn('[HubRelay] The linked computers could not be read, so none can connect', {
    failed: describeFailure(parsed.error),
  });
  return [];
}

/** Write the list, owner-only, and drop the cached copy. */
async function writeList(
  dorkHome: string,
  write: (data: string, options: { mode: number }) => Promise<void>,
  computers: LinkedComputer[]
): Promise<void> {
  ensureFolder(dorkHome);
  try {
    await write(JSON.stringify(computers), { mode: FILE_MODE });
  } finally {
    cache.delete(dorkHome);
  }
}

/**
 * Store a computer's record, or replace the record of one already linked under
 * the same id. Mints nothing: the caller (step B3) made the secret and hands
 * over only its hash. Refuses a 33rd computer, and a secret hash another
 * computer has. Closes no connection: B3 calls `linkComputer` from this
 * folder's `index.ts`, which does.
 *
 * @param input - The computer's id, secret hash and public key.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns The stored record, and whether it replaced one.
 */
export async function storeLinkedComputer(
  input: LinkComputerInput,
  dorkHome: string = resolveDorkHome()
): Promise<{ record: LinkedComputer; replaced: boolean }> {
  const record = LinkedComputerSchema.parse({
    v: 1,
    ...input,
    linkedAt: new Date().toISOString(),
  });
  return withFileLock(filePath(dorkHome), async (write) => {
    const all = readLinkedComputers(dorkHome);
    const others = all.filter((c) => c.computerId !== record.computerId);
    if (others.some((c) => c.secretHash === record.secretHash)) {
      throw new Error('That relay secret already belongs to another computer');
    }
    if (others.length >= HUB_RELAY_MAX_COMPUTERS) {
      throw new Error(`A hub serves at most ${HUB_RELAY_MAX_COMPUTERS} computers`);
    }
    await writeList(dorkHome, write, [...others, record]);
    return { record, replaced: others.length !== all.length };
  });
}

/**
 * Forget a computer: its secret no longer opens a connection. The caller also
 * closes any connection it has open (`dropComputerConnection`).
 *
 * @param computerId - The computer to forget.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns Whether it was linked.
 */
export async function unlinkComputer(
  computerId: string,
  dorkHome: string = resolveDorkHome()
): Promise<boolean> {
  return withFileLock(filePath(dorkHome), async (write) => {
    const all = readLinkedComputers(dorkHome);
    const kept = all.filter((c) => c.computerId !== computerId);
    if (kept.length === all.length) return false;
    await writeList(dorkHome, write, kept);
    return true;
  });
}

/**
 * The linked computer a relay secret belongs to, or `null`. Compares hashes in
 * constant time and always walks the whole list, so how long it takes says
 * nothing about which computer, or how much of a hash, matched.
 *
 * @param secret - The secret from the dial's `Authorization` header.
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function findComputerBySecret(
  secret: string,
  dorkHome: string = resolveDorkHome()
): LinkedComputer | null {
  const offered = Buffer.from(relaySecretHash(secret), 'base64url');
  let found: LinkedComputer | null = null;
  for (const computer of readLinkedComputers(dorkHome)) {
    const stored = Buffer.from(computer.secretHash, 'base64url');
    if (stored.length === offered.length && timingSafeEqual(stored, offered) && !found) {
      found = computer;
    }
  }
  return found;
}
