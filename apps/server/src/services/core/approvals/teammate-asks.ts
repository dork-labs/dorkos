/**
 * "Ask the owner" (DOR-2956, `specs/everything-is-a-space` C7) as the approvals store sees it: a
 * teammate's turn asks the owner for one tool call, the request is an ordinary approval with
 * capability {@link TEAMMATE_ASK_CAPABILITY}, and these are its extra columns, its card fields
 * and its limits.
 *
 * ## Why an ordinary approval
 *
 * It already is what this needs: single use, bound to `(capabilityId, inputHash)`, a two-hour
 * window checked when the token is spent, never "Always allow" when the row does not offer it,
 * and it reaches every surface a person answers approvals on. What it adds is who asked (a space
 * member, not an agent), where the answer will be read (a room in a space), and the exact call,
 * kept off every surface, that the one-call pass is spent on.
 *
 * ## The limits, per teammate
 *
 * Keyed on the space connection and the member id, read from this table so a restart resets
 * nothing, and checked in this order: one request waiting per tool; a day after the owner said
 * no to that tool; three requests an hour. A teammate can then neither queue up cards nor wear
 * the owner down with the same one.
 *
 * @module services/core/approvals/teammate-asks
 */
import { and, eq, gte, isNull, approvals, type Db } from '@dorkos/db';

/** The capability id every teammate request is recorded under. Not on any tool surface. */
export const TEAMMATE_ASK_CAPABILITY = 'teammate.ask_owner';

/** At most three requests per teammate per space connection per hour. */
export const TEAMMATE_ASK_HOURLY_CAP = 3;

/** A Deny holds for a day before the same teammate may ask for the same tool again. */
export const TEAMMATE_ASK_DENY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** Longest name a card shows for the teammate. */
const DISPLAY_NAME_MAX = 80;

/** The exact call a teammate asked for, as the pass will compare it. */
export interface TeammateAskCall {
  /** The runtime's own tool name (`Bash`). */
  tool: string;
  /** Its input, canonical (see `core/turn-power/ask-owner.ts`). */
  input: Record<string, unknown>;
}

/** Everything a teammate's request records beside the approval itself. */
export interface TeammateAsk {
  /** The teammate's member id in the space. */
  memberId: string;
  /** The name the space shows for them, as they set it. */
  displayName: string;
  /** The space connection (`communityRef`) they asked through. */
  connectionRef: string;
  /** Where the result will be posted. */
  resultGoesTo: { room: string; space: string };
  /** The local room the answer runs in. */
  roomId: string;
  /** The agent, by its author id in that room, whose turn asked. */
  authorId: string;
  /** The teammate's message the request is about. */
  aboutEntryId: string;
  /** The call itself. */
  call: TeammateAskCall;
}

/** One stored teammate request, read back for its verdict. */
export interface StoredTeammateAsk extends TeammateAsk {
  /** The approval. */
  approvalId: string;
  /** Its canonical input hash. */
  inputHash: string;
  /** Where it stands. */
  state: 'pending' | 'granted' | 'denied';
  /** Whether it was spent or written off. */
  consumed: boolean;
  /** When the window closes. ISO 8601 UTC. */
  expiresAt: string;
}

/** Why a teammate may not ask right now, from the approvals table. */
export type TeammateAskLimit =
  | { limit: 'pending'; approvalId: string }
  | { limit: 'recently_denied'; approvalId: string }
  | { limit: 'hourly_limit' };

/**
 * Make outsider text safe to store and show as one line: control characters and line breaks
 * become spaces, runs of spaces collapse, and it is capped. A name cannot draw a second line on
 * the card, or pass for the card's own words.
 *
 * @param text - A teammate's name or reason, as they wrote it.
 * @param max - The longest it may be.
 */
export function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what goes
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ');
  const squeezed = flat.replace(/\s+/gu, ' ').trim();
  return squeezed.length <= max ? squeezed : `${squeezed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The columns a teammate's request writes, or all null for any other approval.
 *
 * @param ask - The request, when a teammate made it.
 */
export function teammateColumns(ask: TeammateAsk | undefined): {
  teammateMemberId: string | null;
  connectionRef: string | null;
  resultGoesTo: string | null;
  teammateRequest: string | null;
} {
  if (!ask) {
    return {
      teammateMemberId: null,
      connectionRef: null,
      resultGoesTo: null,
      teammateRequest: null,
    };
  }
  return {
    teammateMemberId: ask.memberId,
    connectionRef: ask.connectionRef,
    resultGoesTo: JSON.stringify({
      room: oneLine(ask.resultGoesTo.room, 120),
      space: oneLine(ask.resultGoesTo.space, 120),
    }),
    teammateRequest: JSON.stringify({
      displayName: oneLine(ask.displayName, DISPLAY_NAME_MAX),
      roomId: ask.roomId,
      authorId: ask.authorId,
      aboutEntryId: ask.aboutEntryId,
      call: ask.call,
    }),
  };
}

/** The stored row's teammate columns. */
interface TeammateRow {
  teammateMemberId: string | null;
  connectionRef: string | null;
  resultGoesTo: string | null;
  teammateRequest: string | null;
}

/** The JSON a column holds, or undefined when it holds none that parses. */
function parsed<T>(json: string | null): T | undefined {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

/**
 * The card's teammate fields: who asked and where the result goes. Absent on every other
 * approval, and on a row whose JSON no longer parses (the card is still a card without them).
 *
 * @param row - The stored approval.
 */
export function teammateCardFields(row: TeammateRow): {
  teammate?: { memberId: string; displayName: string };
  connectionRef?: string;
  resultGoesTo?: { room: string; space: string };
} {
  const request = parsed<{ displayName?: string }>(row.teammateRequest);
  const goesTo = parsed<{ room?: string; space?: string }>(row.resultGoesTo);
  if (!row.teammateMemberId || !row.connectionRef || !request || !goesTo) return {};
  return {
    teammate: {
      memberId: row.teammateMemberId,
      displayName: oneLine(request.displayName ?? '', DISPLAY_NAME_MAX) || 'A teammate',
    },
    connectionRef: row.connectionRef,
    resultGoesTo: { room: goesTo.room ?? '', space: goesTo.space ?? '' },
  };
}

/** The tool a stored request asked for, or undefined. */
function toolOf(row: TeammateRow): string | undefined {
  return parsed<{ call?: { tool?: string } }>(row.teammateRequest)?.call?.tool;
}

/**
 * Whether this teammate may ask for this tool now (see the module doc for the three rules).
 *
 * @param db - The DorkOS database.
 * @param asker - The space connection, the member and the tool.
 * @param now - The clock.
 */
export function teammateAskLimit(
  db: Db,
  asker: { connectionRef: string; memberId: string; tool: string },
  now: number = Date.now()
): TeammateAskLimit | undefined {
  // A Deny can land up to a window after its request, so a day and a window back covers it.
  const since = new Date(now - TEAMMATE_ASK_DENY_COOLDOWN_MS - 2 * HOUR_MS).toISOString();
  const rows = db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.capabilityId, TEAMMATE_ASK_CAPABILITY),
        eq(approvals.connectionRef, asker.connectionRef),
        eq(approvals.teammateMemberId, asker.memberId),
        gte(approvals.createdAt, since)
      )
    )
    .all();
  const sameTool = rows.filter((row) => toolOf(row) === asker.tool);
  const waiting = sameTool.find(
    (row) => row.state === 'pending' && row.consumedAt === null && Date.parse(row.expiresAt) >= now
  );
  if (waiting) return { limit: 'pending', approvalId: waiting.id };
  const cooldownFrom = now - TEAMMATE_ASK_DENY_COOLDOWN_MS;
  const denied = sameTool.find(
    (row) =>
      row.state === 'denied' && row.decidedAt !== null && Date.parse(row.decidedAt) >= cooldownFrom
  );
  if (denied) return { limit: 'recently_denied', approvalId: denied.id };
  const lastHour = rows.filter((row) => Date.parse(row.createdAt) >= now - HOUR_MS).length;
  return lastHour >= TEAMMATE_ASK_HOURLY_CAP ? { limit: 'hourly_limit' } : undefined;
}

/**
 * One teammate request, read back, or undefined when the row is missing, is not a teammate's,
 * or no longer parses.
 *
 * @param db - The DorkOS database.
 * @param approvalId - The approval.
 */
export function readTeammateAsk(db: Db, approvalId: string): StoredTeammateAsk | undefined {
  const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
  if (!row || row.capabilityId !== TEAMMATE_ASK_CAPABILITY) return undefined;
  const request = parsed<
    Pick<TeammateAsk, 'displayName' | 'roomId' | 'authorId' | 'aboutEntryId' | 'call'>
  >(row.teammateRequest);
  const goesTo = parsed<{ room: string; space: string }>(row.resultGoesTo);
  if (!row.teammateMemberId || !row.connectionRef || !request?.call || !goesTo) return undefined;
  return {
    approvalId: row.id,
    inputHash: row.inputHash,
    state: row.state,
    consumed: row.consumedAt !== null,
    expiresAt: row.expiresAt,
    memberId: row.teammateMemberId,
    connectionRef: row.connectionRef,
    resultGoesTo: goesTo,
    displayName: request.displayName,
    roomId: request.roomId,
    authorId: request.authorId,
    aboutEntryId: request.aboutEntryId,
    call: request.call,
  };
}

/**
 * Take the right to act on one teammate request's verdict, once: a conditional write on the
 * delivery claim, as the approval service's own claim is, so two listeners (or one broadcast
 * seen twice) start one turn, never two.
 *
 * @param db - The DorkOS database.
 * @param approvalId - The approval whose verdict is to be acted on.
 * @returns True when this call took the claim.
 */
export function claimTeammateVerdict(db: Db, approvalId: string): boolean {
  const result = db
    .update(approvals)
    .set({ notifiedAt: new Date().toISOString() })
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.capabilityId, TEAMMATE_ASK_CAPABILITY),
        isNull(approvals.notifiedAt)
      )
    )
    .run();
  return result.changes === 1;
}
