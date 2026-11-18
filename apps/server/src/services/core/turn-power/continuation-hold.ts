/**
 * Whether a chat's latest turn read words DorkOS cannot vouch for, kept on the
 * chat's row so it outlives a restart (DOR-3037).
 *
 * A turn a Wi-Fi sign-in started (or a stranger's) runs at the runtime's
 * default at most. Every turn that later picks the same chat up on its own,
 * with nobody newly asking — an approval's answer delivered, an automatic
 * resume or handoff after a usage limit, a nudge after a sign-in, a wake after
 * a restart cut background work short — would otherwise run at the agent's own
 * level on that turn's words. {@link ceilingForContinuation} is the one answer
 * those paths ask.
 *
 * Written by the turn-level seam on every turn a person, an agent or a stranger
 * starts (`recordTurnLevels`), and only when the answer changes, so the hot path
 * adds no write for an ordinary turn. A turn this hold itself clamped
 * (`MessageOpts.continuationHold`) writes nothing: it read no new words, so it
 * leaves the answer the last real turn gave.
 *
 * A chat with no record reads as NOT held (DOR-3203). Only a turn that really
 * read words DorkOS cannot vouch for writes `true`, and every chat that ran
 * before the column existed is settled to `false` by its migration; reading
 * "nothing recorded" as held clamped every such chat woken after the 0.124.1
 * upgrade, and each clamped turn then recorded itself as held. A record that
 * exists but cannot be READ is the other case: it may say held, so it is.
 *
 * @module services/core/turn-power/continuation-hold
 */
import { eq, sessionMetadata, sql, type Db } from '@dorkos/db';
import type { TurnPermissionBound } from '@dorkos/shared/agent-runtime';
import { primaryOf, queueKeyOf } from '../../session/resolution/session-key-registry.js';
import { logger } from '../../../lib/logger.js';
import { env } from '../../../env.js';

let db: Db | undefined;

/** What this process last wrote per chat, so an unchanged answer writes nothing. */
const written = new Map<string, boolean>();

/** Chats this process recorded as holding a stranger's words; the record never clears. */
const strangers = new Set<string>();

/** How many chats the write cache remembers; the oldest go first. */
const WRITTEN_MAX = 10_000;

/**
 * Hand over (or clear) the database the hold is kept in.
 *
 * @param handle - The consolidated database; `undefined` clears it.
 */
export function setContinuationHoldDb(handle: Db | undefined): void {
  db = handle;
  written.clear();
  strangers.clear();
}

/** One turn as the bridged-sender record reads it (DOR-4593). */
export interface BridgedTurn {
  /** Whether the turn carried the outsider mark. */
  readonly marked: boolean;
  /** Whether a Telegram or Slack message started it (`MessageOpts.turnStarter`). */
  readonly bridged: boolean;
}

/**
 * Record whose words a chat holds, for a bridged Telegram or Slack chat (DOR-4593). Any marked
 * turn, or a bridged turn while stranger marking is off (nothing then tells the owner from a
 * stranger), records `stranger`, which nothing clears. Only an unmarked bridged turn with marking
 * on, from a sender the binding vouched for, records `vouched`, and only on a chat with no record.
 * A turn the owner types in the app, or one a continuation's hold clamped, proves nothing and
 * writes nothing. Never throws: a failed write leaves the chat not known, which reads as a
 * stranger's.
 *
 * Only a bridged chat has a bridge to record (DOR-4698): a bridged turn, or a chat whose stored
 * launch origin is a binding's. A marked turn anywhere else still records its hold
 * ({@link noteTurnHold}) and what it read, but not this; stamping it on every marked chat let the
 * outsider hold that ran through agent chats outlive the fix that stopped it.
 *
 * @param sessionId - The id the turn was sent under.
 * @param turn - Whether the turn was marked, and whether a bridged message started it.
 * @param markStrangerTurns - DOR-3858's boot flag; this boot's value by default.
 */
export function noteBridgedSender(
  sessionId: string,
  turn: BridgedTurn,
  markStrangerTurns = env.DORKOS_MARK_STRANGER_TURNS
): void {
  const stranger = turn.marked || (turn.bridged && !markStrangerTurns);
  if (!stranger && !turn.bridged) return;
  if (!db) return;
  if (!turn.bridged && !chatLaunchedByBinding(sessionId)) return;
  // Under every id the chat answers to: a rename moves the row to the newest id while this
  // process files the chat under its first, and a turn may be sent under either.
  for (const key of chatKeys(sessionId)) {
    if (strangers.has(key)) continue;
    // Known here before the write, so a failed write still reads as a stranger's in this process.
    if (stranger) {
      strangers.add(key);
      if (strangers.size > WRITTEN_MAX) strangers.delete(strangers.values().next().value as string);
    }
    try {
      db.insert(sessionMetadata)
        .values({
          sessionId: key,
          runtime: null,
          createdAt: new Date().toISOString(),
          bridgedSender: stranger ? 'stranger' : 'vouched',
        })
        .onConflictDoUpdate({
          target: sessionMetadata.sessionId,
          // `stranger` overwrites anything; `vouched` only fills a chat with no record.
          set: {
            bridgedSender: stranger
              ? 'stranger'
              : sql`coalesce(${sessionMetadata.bridgedSender}, 'vouched')`,
          },
        })
        .run();
    } catch (err) {
      logger.warn('[continuation-hold] could not record whose words a bridged chat holds', {
        sessionId: key,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The ids a chat's record is kept under, once each: the one in hand, the chat's first, and the
 * newest, which its durable rows were moved to (`queueKeyOf`).
 */
function chatKeys(sessionId: string): string[] {
  return [...new Set([sessionId, primaryOf(sessionId), queueKeyOf(sessionId)])];
}

/** The launch origin a chat started by a Telegram or Slack binding is stored with. */
const BINDING_LAUNCH_ORIGIN = 'relay-binding';

/**
 * Whether a chat's stored launch origin is a binding's, under any id it answers to (DOR-4698): the
 * server's own record, which no agent sets. `true` when the record cannot be read, the stricter
 * answer for both readers; `false` with no database or no row.
 *
 * @param sessionId - The chat.
 */
export function chatLaunchedByBinding(sessionId: string): boolean {
  const handle = db;
  if (!handle) return false;
  try {
    return chatKeys(sessionId).some(
      (key) =>
        handle
          .select({ origin: sessionMetadata.launchOrigin })
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, key))
          .get()?.origin === BINDING_LAUNCH_ORIGIN
    );
  } catch (err) {
    logger.warn('[continuation-hold] could not read how a chat was started', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Whether the store holds any record of a chat, under any id it answers to (DOR-4698). A chat with
 * none is unknown, and a sender nobody knows is not clean. `false` with no database, and when the
 * record cannot be read.
 *
 * @param sessionId - The chat.
 */
export function chatRecordKnown(sessionId: string): boolean {
  const handle = db;
  if (!handle) return false;
  try {
    return chatKeys(sessionId).some(
      (key) =>
        handle
          .select({ id: sessionMetadata.sessionId })
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, key))
          .get() !== undefined
    );
  } catch (err) {
    logger.warn('[continuation-hold] could not read whether a chat is known', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Whether a bridged chat holds only words from a sender its binding vouched for (DOR-4593): only
 * when its row under every id it answers to here says so.
 * `false` when it ever held a stranger's, when nothing is recorded, when there is no database, and
 * when the record cannot be read: each reads as a stranger's.
 *
 * @param sessionId - The chat.
 */
export function bridgedSenderVouched(sessionId: string): boolean {
  const keys = chatKeys(sessionId);
  const handle = db;
  if (!handle || keys.some((key) => strangers.has(key))) return false;
  try {
    return keys.every(
      (key) =>
        handle
          .select({ sender: sessionMetadata.bridgedSender })
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, key))
          .get()?.sender === 'vouched'
    );
  } catch (err) {
    logger.warn('[continuation-hold] could not read whose words a bridged chat holds', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Whether a stranger's words ever reached a chat (DOR-3969): its record says a stranger's, which a
 * turn that started marked writes and nothing clears. `true` when the record cannot be read;
 * `false` with no database.
 *
 * @param sessionId - The chat.
 */
export function chatHeldStrangerWords(sessionId: string): boolean {
  const keys = chatKeys(sessionId);
  const handle = db;
  if (keys.some((key) => strangers.has(key))) return true;
  if (!handle) return false;
  try {
    return keys.some(
      (key) =>
        handle
          .select({ sender: sessionMetadata.bridgedSender })
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, key))
          .get()?.sender === 'stranger'
    );
  } catch (err) {
    logger.warn('[continuation-hold] could not read whose words a chat holds', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Carry a chat's bridged-sender record from the id it was filed under to the id it is now known
 * by, when this process learns the link (DOR-4593). A bridged turn after a restart is sent under
 * the chat's born id before the link is learned, so its record lands on that id alone; without
 * this, a later restart reads the newer id's older record. The newer id keeps the stricter of the
 * two: a stranger's if either was, not known if either is, vouched only if both were. A born id
 * with no record carries nothing. Never throws.
 *
 * @param fromId - The id the chat was filed under.
 * @param toId - The id it is now known by.
 */
export function carryBridgedSender(fromId: string, toId: string): void {
  if (!db || fromId === toId) return;
  try {
    const senderOf = (id: string) =>
      db!
        .select({ sender: sessionMetadata.bridgedSender })
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, id))
        .get();
    const from = senderOf(fromId);
    if (!from) return;
    const to = senderOf(toId);
    const merged = to
      ? mergedHolds(
          { lastTurnHeld: null, bridgedSender: from.sender },
          { lastTurnHeld: null, bridgedSender: to.sender }
        ).bridgedSender
      : from.sender;
    if (to && to.sender === merged) return;
    db.insert(sessionMetadata)
      .values({
        sessionId: toId,
        runtime: null,
        createdAt: new Date().toISOString(),
        bridgedSender: merged,
      })
      .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: { bridgedSender: merged } })
      .run();
    if (merged === 'stranger') strangers.add(toId);
  } catch (err) {
    logger.warn('[continuation-hold] could not carry whose words a bridged chat holds', {
      fromId,
      toId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * What a merged chat row keeps of the holds (DOR-4593): held if either row was, and a stranger's
 * if either was, or if either is not known. Only two vouched rows stay vouched.
 *
 * @param a - One row's holds.
 * @param b - The other row's holds.
 */
export function mergedHolds(
  a: { lastTurnHeld: boolean | null; bridgedSender: 'vouched' | 'stranger' | null },
  b: { lastTurnHeld: boolean | null; bridgedSender: 'vouched' | 'stranger' | null }
): { lastTurnHeld: boolean | null; bridgedSender: 'vouched' | 'stranger' | null } {
  const held = a.lastTurnHeld === true || b.lastTurnHeld === true;
  return {
    lastTurnHeld: held ? true : (a.lastTurnHeld ?? b.lastTurnHeld),
    bridgedSender:
      a.bridgedSender === 'vouched' && b.bridgedSender === 'vouched'
        ? 'vouched'
        : a.bridgedSender === 'stranger' || b.bridgedSender === 'stranger'
          ? 'stranger'
          : null,
  };
}

/**
 * Record whether a chat's latest turn was held. Never throws: a failed write
 * leaves the last answer.
 *
 * @param sessionId - The id the turn was sent under.
 * @param held - Whether a hold bound the turn.
 */
export function noteTurnHold(sessionId: string, held: boolean): void {
  const key = primaryOf(sessionId);
  if (!db) return;
  if (written.get(key) === held) return;
  try {
    db.insert(sessionMetadata)
      .values({
        sessionId: key,
        runtime: null,
        createdAt: new Date().toISOString(),
        lastTurnHeld: held,
      })
      .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: { lastTurnHeld: held } })
      .run();
    written.delete(key);
    written.set(key, held);
    if (written.size > WRITTEN_MAX) written.delete(written.keys().next().value as string);
  } catch (err) {
    logger.warn('[continuation-hold] could not record the turn hold', {
      sessionId: key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Whether a chat's latest turn was held, read under the chat's first id.
 * `false` when nothing is recorded, or when there is no database to record in
 * (tests, and nothing writes a hold there either); `true` when the record
 * cannot be read, since it may say held.
 *
 * @param sessionId - The chat.
 */
export function lastTurnHeld(sessionId: string): boolean {
  const key = primaryOf(sessionId);
  const cached = written.get(key);
  if (cached !== undefined) return cached;
  if (!db) return false;
  try {
    const row = db
      .select({ held: sessionMetadata.lastTurnHeld })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, key))
      .get();
    return row?.held === true;
  } catch (err) {
    logger.warn('[continuation-hold] could not read the turn hold; holding the turn', {
      sessionId: key,
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * The ceiling a turn that picks a chat up on its own carries, as the spread a
 * dispatch takes: the runtime's default when the chat's latest turn was held,
 * nothing otherwise. The hold is named as a continuation's
 * (`continuationHold`), so the turn it clamps is held in power only: it
 * neither records itself as held nor marks what it posts as an outsider's.
 *
 * @param sessionId - The chat.
 */
export function ceilingForContinuation(sessionId: string): {
  permissionCeiling?: TurnPermissionBound;
  continuationHold?: true;
} {
  if (!lastTurnHeld(sessionId)) return {};
  return { permissionCeiling: 'runtime-default', continuationHold: true };
}

/**
 * The bound a turn that READS a held chat's words in its seed carries (an automatic carry-over):
 * the runtime's default, and nothing when its latest turn was not held.
 *
 * @param sessionId - The chat whose words are carried over.
 */
export function heldBoundFor(sessionId: string): TurnPermissionBound | undefined {
  return lastTurnHeld(sessionId) ? 'runtime-default' : undefined;
}
