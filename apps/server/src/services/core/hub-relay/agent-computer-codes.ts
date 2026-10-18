/**
 * The machine link codes a hub mints for its cloud agent computers (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md` §2), kept apart from
 * the codes an owner copies by hand (`link-codes.ts`): an agent computer's code
 * never takes one of the owner's three places, and an owner's code never links
 * an agent computer.
 *
 * - **Bound to one computer.** Each code is minted for one cloud computer id
 *   and redeems only for that id.
 * - **One live code per computer.** Minting another replaces the old one.
 * - **Single use, for {@link AGENT_COMPUTER_LINK_CODE_TTL_SECONDS}**, the
 *   contract's limit: never longer.
 * - **It survives the hub sleeping.** Cloud holds the code until the computer
 *   reads it, and a hub that sleeps in between must still know it on waking.
 *   So the book is one owner-only (`0600`) file in the hub relay's owner-only
 *   folder, written atomically under a lock, holding only each code's SHA-256
 *   (`relayLinkCodeHash`). Reading the file never yields a code.
 * - **A spent code is remembered until it expires**, with the key it was
 *   spent by. A second redeem of it is how the hub notices someone else
 *   redeemed first (the contract's accepted risk): see
 *   {@link AgentComputerCodeBook.claim}.
 * - **Slowed on failures, as a backstop**, like the owner's codes: past
 *   {@link AGENT_COMPUTER_LINK_MAX_FAILURES} wrong codes in the window, every
 *   claim is refused until it passes, and minting clears the count.
 *
 * A file that does not parse reads as no codes, so a damaged book refuses
 * every redeem rather than admitting one; the hub mints again.
 *
 * @module services/core/hub-relay/agent-computer-codes
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AGENT_COMPUTER_LINK_CODE_TTL_SECONDS } from '@dork-labs/cloud-api';
import { withFileLock } from '@dorkos/shared/atomic-write';
import { RelayPinnedHubKeySchema } from '@dorkos/shared/session-relay';
import {
  RELAY_LINK_CODE_ALPHABET,
  RELAY_LINK_CODE_LENGTH,
  normalizeRelayLinkCode,
} from '@dorkos/shared/session-relay-link';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { relayLinkCodeHash } from '../session-relay/link-signature.js';

const FOLDER = 'hub-relay';
const FILE = 'agent-computer-codes.json';
const FILE_MODE = 0o600;
const FOLDER_MODE = 0o700;

/** How long an agent computer's code works after the hub mints it. */
export const AGENT_COMPUTER_LINK_CODE_TTL_MS = AGENT_COMPUTER_LINK_CODE_TTL_SECONDS * 1000;

/** Wrong codes allowed in one {@link AGENT_COMPUTER_LINK_FAILURE_WINDOW_MS}, from anywhere. */
export const AGENT_COMPUTER_LINK_MAX_FAILURES = 100;

/** The window wrong codes are counted over. */
export const AGENT_COMPUTER_LINK_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** Most computers one book holds a code for; one hub serves at most 32 computers. */
const MAX_ENTRIES = 64;

const Sha256Schema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/** One computer's code, as stored: its hash, never the code. */
const EntrySchema = z.strictObject({
  /** The cloud computer id the code is bound to. */
  computerId: z.string().min(1).max(61),
  /** `relayLinkCodeHash` of the canonical code. */
  codeHash: Sha256Schema,
  /** When it stops working (epoch ms). */
  expiresAt: z.number().int().positive(),
  /** The computer key it was spent by, or `null` while it is live. */
  spentBy: RelayPinnedHubKeySchema.nullable(),
});

type Entry = z.infer<typeof EntrySchema>;

const FileSchema = z.strictObject({
  v: z.literal(1),
  codes: z.array(EntrySchema).max(MAX_ENTRIES),
});

/** A freshly minted code: the only time the code itself exists outside a hash. */
export interface MintedAgentComputerCode {
  /** The canonical 16 characters, as the contract carries them. */
  code: string;
  /** When it stops working (epoch ms). */
  expiresAt: number;
}

/** What claiming a code came to. */
export type AgentComputerCodeClaim =
  /** The code was live and is now spent, by this key. */
  | { kind: 'fresh' }
  /** The code matched, but was already spent; `byKey` is the key it was spent by. */
  | { kind: 'spent'; byKey: string }
  /** Wrong, expired, or not this computer's: one answer for all three. */
  | { kind: 'invalid' }
  /** Too many wrong codes lately, from anywhere. */
  | { kind: 'throttled' };

/** One hub's agent computer link codes, kept on disk. */
export class AgentComputerCodeBook {
  private failures: number[] = [];

  /**
   * Hold the book's location and clock.
   *
   * @param dorkHome - The data folder; read on every call when omitted.
   * @param now - The clock; injectable for tests.
   */
  constructor(
    private readonly dorkHome: () => string = () => resolveDorkHome(),
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Mint a code for one computer, replacing any code it had (live or spent),
   * and clear the failure count.
   *
   * @param computerId - The cloud computer id the code is bound to.
   */
  async mint(computerId: string): Promise<MintedAgentComputerCode> {
    let code = '';
    for (let i = 0; i < RELAY_LINK_CODE_LENGTH; i++) {
      code += RELAY_LINK_CODE_ALPHABET[randomInt(RELAY_LINK_CODE_ALPHABET.length)];
    }
    const expiresAt = this.now() + AGENT_COMPUTER_LINK_CODE_TTL_MS;
    await this.update((entries) => [
      ...entries.filter((entry) => entry.computerId !== computerId),
      { computerId, codeHash: relayLinkCodeHash(code), expiresAt, spentBy: null },
    ]);
    this.failures = [];
    return { code, expiresAt };
  }

  /**
   * Claim a code for one computer, by the key the redeem was signed with. A
   * live code is spent by that key; a code already spent answers who spent
   * it, so the caller can tell a retry by the same computer from a second
   * redeem by another. Compares hashes in constant time.
   *
   * @param computerId - The cloud computer id the redeem names.
   * @param input - The code as the request carried it.
   * @param computerKey - The key the redeem was signed with.
   */
  async claim(
    computerId: string,
    input: string,
    computerKey: string
  ): Promise<AgentComputerCodeClaim> {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < AGENT_COMPUTER_LINK_FAILURE_WINDOW_MS);
    if (this.failures.length >= AGENT_COMPUTER_LINK_MAX_FAILURES) return { kind: 'throttled' };
    const code = normalizeRelayLinkCode(input);
    const offered = Buffer.from(relayLinkCodeHash(code ?? ''), 'base64url');
    let claim = { kind: 'invalid' } as AgentComputerCodeClaim;
    await this.update((entries) =>
      entries.map((entry) => {
        if (entry.computerId !== computerId || code === null) return entry;
        const stored = Buffer.from(entry.codeHash, 'base64url');
        if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) return entry;
        if (entry.spentBy !== null) {
          claim = { kind: 'spent', byKey: entry.spentBy };
          return entry;
        }
        claim = { kind: 'fresh' };
        return { ...entry, spentBy: computerKey };
      })
    );
    if (claim.kind === 'invalid') this.failures.push(now);
    return claim;
  }

  /**
   * Forget a computer's code, live or spent.
   *
   * @param computerId - The cloud computer id.
   */
  async forget(computerId: string): Promise<void> {
    await this.update((entries) => entries.filter((entry) => entry.computerId !== computerId));
  }

  /** Read, change and write the book under its lock, dropping expired codes. */
  private async update(change: (entries: Entry[]) => Entry[]): Promise<void> {
    const dorkHome = this.dorkHome();
    const file = path.join(dorkHome, FOLDER, FILE);
    await withFileLock(file, async (write) => {
      const now = this.now();
      const live = readEntries(file).filter((entry) => entry.expiresAt > now);
      const next = change(live).slice(-MAX_ENTRIES);
      const dir = path.join(dorkHome, FOLDER);
      fs.mkdirSync(dir, { recursive: true, mode: FOLDER_MODE });
      fs.chmodSync(dir, FOLDER_MODE);
      await write(JSON.stringify({ v: 1, codes: next }), { mode: FILE_MODE });
    });
  }
}

/** The stored codes, or none when the file is missing or does not parse. */
function readEntries(file: string): Entry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = FileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.codes;
  } catch {
    // Falls through to the warning.
  }
  logger.warn('[HubRelay] The agent computer link codes could not be read; none will redeem');
  return [];
}

/** The live hub's agent computer codes. */
export const agentComputerCodes = new AgentComputerCodeBook();
