/**
 * The forced-limit seam for re-seating (DOR-3143): a small, fake world of
 * Claude accounts for the TEST harness, so a browser suite can make one named
 * account run out and watch a room seat move, with no real account involved.
 *
 * **Test builds only, and inert everywhere else.** Nothing reads an environment
 * variable here. The world starts empty, and the only way to fill it is
 * {@link setTestAccountWorld}, which refuses unless the server is running the
 * test runtime (`DORKOS_TEST_RUNTIME`). The test-control route that calls it is
 * mounted only under that same flag. With no world, every reader below answers
 * "nothing forced", and the production paths run untouched.
 *
 * What the world stands in for, and where it is read:
 *
 * - **Which account a session bills**: the account its first launch was hinted
 *   onto (a moved seat), else the world's starting account. Read by the seat
 *   mover in place of the usage store (`create-seat-mover.ts`).
 * - **The accounts and their usage**: the world's list, ranked in the order
 *   given. Read by the seat mover in place of core's ranking.
 * - **The limit**: once a turn runs on the forced account, that account is out
 *   and its sessions report a usage limit (`storedUsageLimit`), exactly as the
 *   Claude Code runtime's limit store would.
 * - **The failing turn**: the test-mode runtime ends a turn on the forced
 *   account in an error, either at once (`turn-start`) or after it has posted in
 *   the room and run a tool (`after-post`).
 *
 * Seats only move on Claude Code, so while a world is set the mover reads a
 * test-runtime session as a Claude Code one (`asWorldRuntime`).
 *
 * @module services/rooms/reseat/test-account-world
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { RankedAccount } from '../../core/usage/account-ranking.js';

/** When the forced account runs out during a turn. */
export type ForcedLimitAt = 'turn-start' | 'after-post';

/** One account in the test world. */
export interface TestWorldAccount {
  id: string;
  label?: string;
  /** Share of the 5-hour window used; 95 or more reads as nearly out. */
  fiveHourPct?: number;
  /** Out from the start, before any turn hits it. */
  limited?: boolean;
}

/** What a test sets. */
export interface TestAccountWorldInput {
  /** The accounts, best first. */
  accounts: TestWorldAccount[];
  /** The account a session bills before any move. */
  startAccount: string;
  /** The account that runs out the first time a turn runs on it, and when. */
  force?: { accountId: string; at: ForcedLimitAt; resetsAt?: string };
}

interface World extends TestAccountWorldInput {
  /** The account each session launched on. */
  sessions: Map<string, string>;
  /** Sessions a turn has run on: only those have a "transcript". */
  ran: Set<string>;
  /** Accounts a turn has run out. */
  out: Set<string>;
}

let world: World | null = null;

/**
 * Set the test world, or `null` to clear it. Refused outside the test runtime,
 * so a shipped server can never be made to fake a limit.
 *
 * @param next - The world, or `null`.
 * @param testMode - Whether the server runs the test runtime.
 * @throws {Error} When `testMode` is false and `next` is not `null`.
 */
export function setTestAccountWorld(next: TestAccountWorldInput | null, testMode: boolean): void {
  if (next === null) {
    world = null;
    return;
  }
  if (!testMode) {
    throw new Error('The test account world is only available to the test runtime.');
  }
  world = { ...next, sessions: new Map(), ran: new Set(), out: new Set() };
}

/** Whether a test world is set. */
export function hasTestAccountWorld(): boolean {
  return world !== null;
}

/**
 * Record that a turn launched on a session: the account it bills (its hint the
 * first time, if any) and that it now has a "transcript".
 *
 * @param sessionId - The session.
 * @param accountHint - The launch hint the turn carried, if any.
 */
export function noteTestWorldLaunch(sessionId: string, accountHint: string | undefined): void {
  if (world === null) return;
  if (!world.sessions.has(sessionId)) {
    world.sessions.set(sessionId, accountHint ?? world.startAccount);
  }
  world.ran.add(sessionId);
}

/** The account a session bills in the test world, or `null` with no world. */
export function testWorldAccountOf(sessionId: string): string | null {
  if (world === null) return null;
  return world.sessions.get(sessionId) ?? world.startAccount;
}

/**
 * Whether this turn must fail on a usage limit, and when. Marks the forced
 * account out, so every session on it reports the limit from now on.
 *
 * @param sessionId - The session the turn runs on.
 */
export function forcedLimitFor(sessionId: string): ForcedLimitAt | null {
  if (world === null || world.force === undefined) return null;
  const account = testWorldAccountOf(sessionId);
  if (account !== world.force.accountId) return null;
  world.out.add(account);
  return world.force.at;
}

/**
 * The usage limit a session is under in the test world, as the limit store
 * would report it; `null` with no world or no limit.
 *
 * @param sessionId - The session.
 */
export function testWorldLimitOf(sessionId: string): { resetsAt: string | null } | null {
  if (world === null) return null;
  const account = testWorldAccountOf(sessionId);
  const entry = world.accounts.find((a) => a.id === account);
  if (account === null || !(world.out.has(account) || entry?.limited === true)) return null;
  return { resetsAt: world.force?.resetsAt ?? new Date(Date.now() + 60 * 60_000).toISOString() };
}

/** Whether a session has run a turn in the test world. */
export function testWorldRan(sessionId: string): boolean {
  return world?.ran.has(sessionId) === true;
}

/** One world account as core's ranking would describe it. */
function ranked(account: TestWorldAccount, out: boolean): RankedAccount {
  const limited = out || account.limited === true;
  const label = account.label ?? account.id;
  return {
    runtime: 'claude-code',
    id: account.id,
    label,
    color: '#64748b',
    eligible: !limited,
    reason: limited ? 'Out of usage' : '',
    usage: {
      runtime: 'claude-code',
      accountId: account.id,
      path: `/test-world/${account.id}`,
      label,
      color: '#64748b',
      subscriptionType: null,
      plan: null,
      credits: null,
      spend: null,
      windows: [
        {
          key: 'five_hour',
          label: '5-hour window',
          usedPct: limited ? 100 : (account.fiveHourPct ?? 10),
          resetsAt: null,
          status: null,
          expired: false,
          observedAt: new Date().toISOString(),
          source: 'sdk_usage',
        },
      ],
      state: limited ? 'limited' : 'ok',
      limit: limited ? { window: 'five_hour', resetsAt: null } : null,
      updatedAt: null,
    } satisfies AccountUsage,
  };
}

/** The test world's accounts, best first, or `null` with no world. */
export function testWorldRanking(): RankedAccount[] | null {
  if (world === null) return null;
  const out = world.out;
  return world.accounts.map((account) => ranked(account, out.has(account.id)));
}

/**
 * The test world's view of one account, for the mover's "which account is this
 * seat on", or `null` with no world.
 *
 * @param sessionId - The session.
 */
export function testWorldSeatAccount(
  sessionId: string
): { id: string; label: string | null; usage: AccountUsage } | null {
  const ranking = testWorldRanking();
  const id = testWorldAccountOf(sessionId);
  const row = ranking?.find((r) => r.id === id);
  return row ? { id: row.id, label: row.label, usage: row.usage } : null;
}
