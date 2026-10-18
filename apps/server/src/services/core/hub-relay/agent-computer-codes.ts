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
 * - **Slowed on failures, as a backstop, per computer**: past
 *   {@link AGENT_COMPUTER_LINK_MAX_FAILURES} wrong codes for one computer in
 *   the window, further wrong codes for it answer "too many tries" until it
 *   passes or the hub mints it a new code. The right code is checked first
 *   and always links, so wrong codes can never hold up the real computer. Only a computer that has a code counts failures, so
 *   codes sent for ids that do not exist cost nothing and lock nobody out.
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

/** Wrong codes allowed for one computer in one {@link AGENT_COMPUTER_LINK_FAILURE_WINDOW_MS}. */
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
  /** Too many wrong codes for this computer lately. */
  | { kind: 'throttled' };

/** One hub's agent computer link codes, kept on disk. */
export class AgentComputerCodeBook {
  /** Wrong codes lately, per computer that has a code: when each came in. */
  private failures = new Map<string, number[]>();

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
   * and clear that computer's failure count.
   *
   * @param computerId - The cloud computer id the code is bound to.
   */
  async mint(computerId: string): Promise<MintedAgentComputerCode> {
    let code = '';
    for (let i = 0; i < RELAY_LINK_CODE_LENGTH; i++) {
      code += RELAY_LINK_CODE_ALPHABET[randomInt(RELAY_LINK_CODE_ALPHABET.length)];
    }
    const expiresAt = this.now() + AGENT_COMPUTER_LINK_CODE_TTL_MS;
    await this.locked((entries) => {
      this.failures.delete(computerId);
      return {
        next: [
          ...entries.filter((entry) => entry.computerId !== computerId),
          { computerId, codeHash: relayLinkCodeHash(code), expiresAt, spentBy: null },
        ],
        result: undefined,
      };
    });
    return { code, expiresAt };
  }

  /**
   * Claim a code for one computer, by the key the redeem was signed with, and
   * act on the claim while still holding the book's lock. A live code is
   * spent by that key; a code already spent answers who spent it, so the
   * caller can tell a retry by the same computer from a second redeem by
   * another. Compares hashes in constant time.
   *
   * `act` runs inside the lock, so two redeems of one code are decided one
   * after the other, each seeing what the other stored: a second redeem can
   * never unlink the computer while the first is still linking it. `act` must
   * not touch this book (it would wait on its own lock); work that does, such
   * as minting a new code, goes after `claim` returns.
   *
   * Throttling and the failure count, checked and changed under the same
   * lock, after the code: only a wrong code for a computer that has a code
   * counts, against that computer alone, and the right code is never slowed.
   *
   * @param computerId - The cloud computer id the redeem names.
   * @param input - The code as the request carried it.
   * @param computerKey - The key the redeem was signed with.
   * @param act - What to do with the claim, inside the lock.
   */
  async claim<R>(
    computerId: string,
    input: string,
    computerKey: string,
    act: (claim: AgentComputerCodeClaim) => Promise<R>
  ): Promise<R> {
    return this.lockedAsync(async (entries) => {
      const now = this.now();
      const entry = entries.find((e) => e.computerId === computerId);
      if (!entry) return { next: null, after: () => act({ kind: 'invalid' }) };
      const code = normalizeRelayLinkCode(input);
      const offered = Buffer.from(relayLinkCodeHash(code ?? ''), 'base64url');
      const stored = Buffer.from(entry.codeHash, 'base64url');
      const matches =
        code !== null && stored.length === offered.length && timingSafeEqual(stored, offered);
      if (!matches) {
        // Only wrong codes count, and only they are slowed: the right code
        // links however many wrong ones came before it.
        const recent = (this.failures.get(computerId) ?? []).filter(
          (at) => now - at < AGENT_COMPUTER_LINK_FAILURE_WINDOW_MS
        );
        const throttled = recent.length >= AGENT_COMPUTER_LINK_MAX_FAILURES;
        this.failures.set(computerId, throttled ? recent : [...recent, now]);
        return { next: null, after: () => act({ kind: throttled ? 'throttled' : 'invalid' }) };
      }
      if (entry.spentBy !== null) {
        const byKey = entry.spentBy;
        return { next: null, after: () => act({ kind: 'spent', byKey }) };
      }
      // Spent on disk before anything acts on it.
      const next = entries.map((e) => (e === entry ? { ...e, spentBy: computerKey } : e));
      return { next, after: () => act({ kind: 'fresh' }) };
    });
  }

  /**
   * Whether a computer has a code that is live and not yet spent.
   *
   * @param computerId - The cloud computer id.
   */
  async hasLiveCode(computerId: string): Promise<boolean> {
    return this.locked((entries) => ({
      next: null,
      result: entries.some((e) => e.computerId === computerId && e.spentBy === null),
    }));
  }

  /**
   * Forget a computer's code, live or spent.
   *
   * @param computerId - The cloud computer id.
   */
  async forget(computerId: string): Promise<void> {
    await this.locked((entries) => ({
      next: entries.filter((entry) => entry.computerId !== computerId),
      result: undefined,
    }));
  }

  /** {@link lockedAsync} for a change that decides at once. */
  private locked<R>(change: (entries: Entry[]) => { next: Entry[] | null; result: R }) {
    return this.lockedAsync(async (entries) => {
      const { next, result } = change(entries);
      return { next, after: async () => result };
    });
  }

  /**
   * Read the book under its lock, dropping expired codes, and write it back
   * only when `change` returns a new list (or an expired code was dropped).
   * `after` runs after the write, still in the lock. (Not `then`: an object
   * with a `then` is a thenable, and awaiting it would never settle.)
   */
  private async lockedAsync<R>(
    change: (entries: Entry[]) => Promise<{ next: Entry[] | null; after: () => Promise<R> }>
  ): Promise<R> {
    const dorkHome = this.dorkHome();
    const file = path.join(dorkHome, FOLDER, FILE);
    return withFileLock(file, async (write) => {
      const now = this.now();
      const stored = readEntries(file);
      const live = stored.filter((entry) => entry.expiresAt > now);
      const { next, after } = await change(live);
      const toWrite = next ?? (live.length !== stored.length ? live : null);
      if (toWrite !== null) {
        const dir = path.join(dorkHome, FOLDER);
        fs.mkdirSync(dir, { recursive: true, mode: FOLDER_MODE });
        fs.chmodSync(dir, FOLDER_MODE);
        await write(JSON.stringify({ v: 1, codes: toWrite.slice(-MAX_ENTRIES) }), {
          mode: FILE_MODE,
        });
      }
      return after();
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
