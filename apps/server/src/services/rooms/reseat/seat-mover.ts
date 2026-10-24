/**
 * Re-seating: moving an agent's room seat to a fresh session so it keeps
 * answering (Re-seat P0). A seat is the `(room, agent)` session binding.
 *
 * Four things move a seat, and every one goes through {@link RoomSeatMover.reseat},
 * the one shared function:
 *
 * - **Its account ran out** during a turn: move once per message, then answer
 *   that message again on the new seat (the dispatcher's re-run).
 * - **Its account is nearly out** (95% of the 5-hour or weekly window) before a
 *   turn starts: move first, then run the turn on the new seat.
 * - **Its transcript expired** (Claude Code removes old ones): start a fresh
 *   session in the same seat, with no account change.
 * - **A person moved it** (`rooms.reseat`).
 *
 * What a move carries, in order, and why each is not optional:
 *
 * 1. The old seat's settings row, through `reseatSettings` (Security Must 1),
 *    written BEFORE the first turn so the room's new-session seed never applies.
 *    A seat that stored no mode moves at the mode it ran at
 *    ({@link SeatMoverDeps.effectiveModeOf}), never the runtime's bare default.
 * 2. The old seat's marks (`carrySessionMarks`, Must 2), so a stranger's words in
 *    the summary stay marked.
 * 3. A one-shot pending launch for the seat: the account to start on (a launch
 *    hint, honoured only for a session with no transcript, so "Runs on" is
 *    never changed) and the summary. The dispatcher takes it on the seat's next
 *    turn and it is gone.
 * 4. One Activity entry (Must 6).
 *
 * The room's line is the dispatcher's to write: only it knows whether the room
 * has outsiders, which decides whether accounts are named (Must 7).
 *
 * @module services/rooms/reseat/seat-mover
 */
import { randomUUID } from 'node:crypto';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { DeclaredPermissionModes } from '@dorkos/shared/permission-semantics';
import type { SessionSettings } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';
import type { RankedAccount } from '../../core/usage/account-ranking.js';
import { carrySessionMarks } from '../../core/turn-power/seat-marks.js';
import { reseatSettings } from '../../session/fleet/carry-over-power.js';
import type { ReseatNoticeReason } from '../notices/notice-copy.js';
import { canTakeWork, nearlyOut, pickReseatAccount, reseatCandidates } from './reseat-accounts.js';

/** The runtime whose accounts can run out and be moved between. */
export const RESEAT_RUNTIME = 'claude-code';

/**
 * Whether an AGENT may move its own seat with the `reseat` tool (Security
 * Must 5). A tool that lets an agent spend another account widens what agents
 * can do, so it needs Dorian's own yes; until then only a person may. The one
 * switch: flipping it lets an agent move ITS OWN seat, never another's, and
 * never from a marked turn. The automatic move does not read it.
 */
export const AGENT_MAY_RESEAT_OWN_SEAT = false;

/**
 * Whether this caller may move this seat by hand (Security Must 5): always a
 * person; an agent only when {@link AGENT_MAY_RESEAT_OWN_SEAT} is on, only its
 * OWN seat, and never from a marked turn. The one check every by-hand surface
 * asks, so turning agents on is the one-line flip above.
 *
 * @param who.callerIsPerson - The caller is a person, not an agent.
 * @param who.callerId - The caller's author id.
 * @param who.seatAuthorId - The agent whose seat would move.
 * @param who.markedTurn - The calling turn carries a mark (read outside words).
 * @param agentsAllowed - The switch; the constant unless a test passes its own.
 */
export function mayReseatByHand(
  who: { callerIsPerson: boolean; callerId: string; seatAuthorId: string; markedTurn: boolean },
  agentsAllowed: boolean = AGENT_MAY_RESEAT_OWN_SEAT
): boolean {
  if (who.callerIsPerson) return true;
  return agentsAllowed && who.callerId === who.seatAuthorId && !who.markedTurn;
}

/** A room seat, as the mover needs it. */
export interface Seat {
  roomId: string;
  authorId: string;
  /** The agent's home: its folder, and so its project. */
  agentPath: string;
  /** The session bound to the seat, or `null` before its first answer. */
  sessionId: string | null;
}

/** What a seat's next turn starts with after a move, until a turn on it launches. */
export interface PendingLaunch {
  sessionId: string;
  /** The account the new session launches on, when the move picked one. */
  accountHint?: string;
  /** What the new session is told about the old one. */
  seedContext?: string;
}

/** A move that happened. */
export interface SeatMove {
  newSessionId: string;
  /** For the room's line. */
  reason: ReseatNoticeReason;
}

/** Why the seat moved, for the Activity entry. */
export type ReseatTrigger = 'limit' | 'nearly-out' | 'stranded' | 'person';

/** One Activity entry per move (Security Must 6). */
export interface ReseatActivity {
  trigger: ReseatTrigger;
  /** Who asked, for a move by hand. */
  by?: string;
  roomId: string;
  authorId: string;
  /** The message the move was made to answer, when one caused it. */
  entryId: string | null;
  fromSessionId: string | null;
  toSessionId: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  /** What the owner calls each account, for the entry's sentence. */
  fromAccountLabel: string | null;
  toAccountLabel: string | null;
}

/** The account a seat runs on now, as the usage store knows it. */
export interface SeatAccount {
  id: string | null;
  label: string | null;
  usage: AccountUsage | null;
}

/** Everything the mover reads from or writes to the app. Injected so a test supplies all of it. */
export interface SeatMoverDeps {
  /** Move the seat's binding; `false` when the store refused or there was no seat. */
  rebind(roomId: string, authorId: string, sessionId: string): boolean;
  /** The runtime a session is bound to, or the agent's for an unbound seat. */
  runtimeOf(seat: Seat): Promise<string>;
  /**
   * The runtime a brand-new session for this agent would start on (its
   * manifest's today). A move never crosses runtimes, so a seat whose agent
   * has since moved to another program stays where it is.
   */
  newSeatRuntime(agentPath: string): Promise<string>;
  /** A session's stored settings row, or `null` for none. */
  settingsOf(sessionId: string): Promise<SessionSettings | null>;
  /** Write a session's settings row. */
  saveSettings(sessionId: string, settings: SessionSettings): Promise<void>;
  /** A runtime's declared permission modes. */
  declaredModes(runtime: string): DeclaredPermissionModes | undefined;
  /**
   * The mode a seat that stored none ran at: what the room's unattended
   * resolver gives its agent on this runtime (the agent's own Files & commands
   * stop, else the operator's level). `undefined` when nothing is configured,
   * and the runtime's own default stands.
   */
  effectiveModeOf(seat: Seat, runtime: string): Promise<string | undefined>;
  /** The account a session bills now. */
  accountOf(runtime: string, sessionId: string, cwd: string): Promise<SeatAccount>;
  /** Core's ranking of a runtime's accounts allowed in the folder's project. */
  ranking(runtime: string, cwd: string): Promise<RankedAccount[]>;
  /**
   * Whether the seat's transcript is on disk: `missing` only when it is known
   * gone; `unknown` for a session no runtime has run yet, a runtime that keeps
   * no transcript, or a probe that failed.
   */
  transcriptState(seat: Seat): Promise<'present' | 'missing' | 'unknown'>;
  /** The summary of the old session a moved seat starts from. */
  summaryOf(input: {
    sessionId: string;
    cwd: string;
    accountLabel: string;
    /** The account's folder, for the transcript's path; `null` when unknown or not to be named. */
    accountPath: string | null;
    /** The window that stopped or nearly stopped it. */
    window: string;
    resetsAt: string | null;
    /** `limit` when its account ran out; `moved` when it was moved before that. */
    stoppedBecause: 'limit' | 'moved';
  }): Promise<string>;
  /** Record the move in the Activity feed. Never throws. */
  recordActivity(entry: ReseatActivity): void;
  /** A fresh session id; injected so a test can name it. */
  newSessionId?(): string;
}

/** What the new session is told when it continues a message the old one had started on. */
const CONTINUE_LINE =
  'Your previous session stopped while answering the latest message here, because its account ran out of usage. ';
const ALREADY_POSTED_LINE =
  'It already posted in the room for that message. Do not answer it again; only finish what is left, if anything.';
const NOT_POSTED_LINE =
  'If the summary shows it already did part of the work, finish that work rather than starting over.';
const STRANDED_SEED =
  'Your earlier session in this room expired, so this is a fresh one. The room history above is the conversation so far.';

/** How many `(room, agent, message)` moves are remembered, so one message moves a seat once. */
const MOVED_MEMORY = 5_000;

/** What a move after a limit came to. */
export type AfterLimit =
  | { kind: 'moved'; move: SeatMove }
  | { kind: 'none'; earliestResetAt: string | null }
  | { kind: 'already-moved' }
  | { kind: 'cannot-move' };

/** The room seat mover. One per server. */
export class RoomSeatMover {
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly movedFor = new Set<string>();

  constructor(private readonly deps: SeatMoverDeps) {}

  /**
   * The pending launch for a seat's next turn, read but kept: it is dropped
   * only by {@link settleLaunch}, once a turn on that session has launched, so
   * a turn refused before launch leaves it for the next one. Only when the seat
   * is still bound to the session the move made.
   *
   * Kept in memory. A restart before the moved seat's first turn loses it, and
   * that turn then starts on the agent's usual account; if that one is out,
   * the turn fails and the seat moves again.
   *
   * @param roomId - The room.
   * @param authorId - The agent member.
   * @param sessionId - The session the seat is bound to now.
   */
  pendingLaunch(roomId: string, authorId: string, sessionId: string): PendingLaunch | undefined {
    const launch = this.pending.get(seatKey(roomId, authorId));
    return launch?.sessionId === sessionId ? launch : undefined;
  }

  /**
   * A turn on the moved session launched, so its launch is spent: from now on
   * the session's transcript says which account it is on.
   *
   * @param roomId - The room.
   * @param authorId - The agent member.
   * @param sessionId - The session the turn ran on.
   */
  settleLaunch(roomId: string, authorId: string, sessionId: string): void {
    const key = seatKey(roomId, authorId);
    if (this.pending.get(key)?.sessionId === sessionId) this.pending.delete(key);
  }

  /**
   * Before a turn: start a fresh session for a seat whose transcript expired,
   * or move a seat whose account is out or nearly out when another account
   * has room. Nothing for an unbound seat or a runtime without accounts.
   *
   * @param seat - The seat about to run a turn.
   * @param entryId - The message the turn answers.
   * @param opts.hideAccounts - The room has outsiders: name no account in the summary.
   * @returns The move, or `null` when the seat stays.
   */
  async beforeTurn(
    seat: Seat,
    entryId: string,
    opts: { hideAccounts: boolean }
  ): Promise<SeatMove | null> {
    if (seat.sessionId === null) return null;
    const runtime = await this.deps.runtimeOf(seat);
    if (!(await this.mayMoveOn(runtime, seat))) return null;
    const transcript = await this.deps.transcriptState(seat);
    if (transcript === 'missing') {
      this.noteMoved(seat, entryId);
      return this.reseat(seat, { trigger: 'stranded', entryId, runtime, ...opts });
    }
    // A seat that never ran keeps the room's new-session rules; only a running
    // conversation is moved ahead of its limit.
    if (transcript !== 'present') return null;
    const current = await this.deps.accountOf(runtime, seat.sessionId, seat.agentPath);
    if (current.id === null || current.usage === null || !nearlyOut(current.usage)) return null;
    const pick = pickReseatAccount(await this.deps.ranking(runtime, seat.agentPath), {
      runtime,
      currentAccountId: current.id,
    });
    if (pick.kind === 'none') return null;
    // Counted against the message, so a limit later in the same turn does not
    // move the seat a second time.
    this.noteMoved(seat, entryId);
    return this.reseat(seat, {
      trigger: 'nearly-out',
      entryId,
      runtime,
      current,
      target: pick.account,
      ...opts,
    });
  }

  /**
   * After a turn failed because the seat's account ran out: move the seat once
   * for this message. `already-moved` for a second move on the same message,
   * so a message never moves a seat twice and nothing loops. `cannot-move` when
   * this seat is not one a move applies to (no session, another runtime, an
   * agent that changed program, an account nobody can name): nothing was
   * tried, so the room says what it always said.
   *
   * @param seat - The seat whose turn failed.
   * @param entryId - The message it was answering.
   * @param opts.alreadyPosted - The failed turn had already posted in the room.
   * @param opts.hideAccounts - The room has outsiders: name no account in the summary.
   */
  async afterLimit(
    seat: Seat,
    entryId: string,
    opts: { alreadyPosted: boolean; hideAccounts: boolean }
  ): Promise<AfterLimit> {
    if (!this.mayMoveFor(seat, entryId)) return { kind: 'already-moved' };
    if (seat.sessionId === null) return { kind: 'cannot-move' };
    const runtime = await this.deps.runtimeOf(seat);
    if (!(await this.mayMoveOn(runtime, seat))) return { kind: 'cannot-move' };
    const current = await this.deps.accountOf(runtime, seat.sessionId, seat.agentPath);
    // An account nobody can name cannot be left out of the pick, and moving the
    // seat back onto the account that just ran out helps nobody.
    if (current.id === null) return { kind: 'cannot-move' };
    this.noteMoved(seat, entryId);
    const pick = pickReseatAccount(await this.deps.ranking(runtime, seat.agentPath), {
      runtime,
      currentAccountId: current.id,
    });
    if (pick.kind === 'none') return pick;
    const move = await this.reseat(seat, {
      trigger: 'limit',
      entryId,
      runtime,
      current,
      target: pick.account,
      ...opts,
    });
    return { kind: 'moved', move };
  }

  /**
   * Whether this seat may still move for this message.
   *
   * @param seat - The seat.
   * @param entryId - The message.
   */
  mayMoveFor(seat: Pick<Seat, 'roomId' | 'authorId'>, entryId: string): boolean {
    return !this.movedFor.has(`${seatKey(seat.roomId, seat.authorId)}\u0000${entryId}`);
  }

  /**
   * The accounts a person may move a seat to, best first, with the seat's own
   * account excluded and each marked whether it can take work now.
   *
   * @param seat - The seat.
   */
  async options(seat: Seat): Promise<{ current: SeatAccount; accounts: RankedAccount[] }> {
    const runtime = await this.deps.runtimeOf(seat);
    const none = { current: { id: null, label: null, usage: null }, accounts: [] };
    if (seat.sessionId === null || !(await this.mayMoveOn(runtime, seat))) return none;
    const current = await this.deps.accountOf(runtime, seat.sessionId, seat.agentPath);
    const ranking = await this.deps.ranking(runtime, seat.agentPath);
    return {
      current,
      // A person may name an account kept out of automatic moves, so it is offered.
      accounts: reseatCandidates(ranking, runtime, { keptOut: true })
        .filter((row) => row.id !== current.id)
        .map((row) => {
          const eligible = canTakeWork(row);
          // Core calls an account with any usage left eligible; a move also
          // skips one that is nearly out, and says so.
          const reason = !eligible && row.eligible ? 'Almost out of usage' : row.reason;
          return { ...row, eligible, reason };
        }),
    };
  }

  /**
   * Move a seat by hand. The account must be one {@link options} offers and
   * can take work now; with none named, the best one DorkOS would pick itself,
   * so an account kept out of automatic moves is used only when named.
   *
   * @param seat - The seat.
   * @param opts.accountId - The account to move to; the best when absent.
   * @param opts.by - Who asked, as the room names them.
   * @param opts.hideAccounts - The room has outsiders: name no account in the summary.
   * @returns The move; `nothing-to-move` for a seat with no session yet (its
   *   first turn starts wherever the agent's usual account is); `null` when no
   *   account can take it.
   */
  async byHand(
    seat: Seat,
    opts: { accountId?: string; by: string; hideAccounts: boolean }
  ): Promise<SeatMove | 'nothing-to-move' | null> {
    if (seat.sessionId === null) return 'nothing-to-move';
    const runtime = await this.deps.runtimeOf(seat);
    if (!(await this.mayMoveOn(runtime, seat))) return null;
    const current = await this.deps.accountOf(runtime, seat.sessionId, seat.agentPath);
    const ranking = await this.deps.ranking(runtime, seat.agentPath);
    const named = opts.accountId !== undefined;
    const offered = named ? ranking.filter((row) => row.id === opts.accountId) : ranking;
    const pick = pickReseatAccount(
      offered,
      { runtime, currentAccountId: current.id },
      { keptOut: named }
    );
    if (pick.kind === 'none') return null;
    return this.reseat(seat, {
      trigger: 'person',
      by: opts.by,
      entryId: null,
      runtime,
      current,
      target: pick.account,
      hideAccounts: opts.hideAccounts,
    });
  }

  /** Whether a seat on this runtime can move: accounts that run out, and no change of program. */
  private async mayMoveOn(runtime: string, seat: Seat): Promise<boolean> {
    if (runtime !== RESEAT_RUNTIME) return false;
    return (await this.deps.newSeatRuntime(seat.agentPath)) === runtime;
  }

  private noteMoved(seat: Pick<Seat, 'roomId' | 'authorId'>, entryId: string): void {
    remember(this.movedFor, `${seatKey(seat.roomId, seat.authorId)}\u0000${entryId}`);
  }

  /**
   * The one shared function: give the seat a fresh session carrying the old
   * one's power and marks, and leave its next turn a launch.
   */
  private async reseat(
    seat: Seat,
    plan: {
      trigger: ReseatTrigger;
      by?: string;
      entryId: string | null;
      runtime: string;
      current?: SeatAccount;
      target?: RankedAccount;
      alreadyPosted?: boolean;
      hideAccounts: boolean;
    }
  ): Promise<SeatMove> {
    const newSessionId = this.deps.newSessionId?.() ?? randomUUID();
    const old = seat.sessionId;
    // Power first (Must 1): the row exists before anything can launch on it.
    const settings = old === null ? null : await this.deps.settingsOf(old);
    // A stored mode is the person-set level and wins; with none, the seat ran
    // at its agent's effective level, so that is what it keeps.
    const ranAt = settings?.permissionMode
      ? undefined
      : await this.deps.effectiveModeOf(seat, plan.runtime);
    await this.deps.saveSettings(
      newSessionId,
      reseatSettings(settings, this.deps.declaredModes(plan.runtime), ranAt)
    );
    // Marks next (Must 2), before the first turn.
    if (old !== null) carrySessionMarks(old, newSessionId);
    const seedContext = await this.seedFor(seat, plan);
    if (!this.deps.rebind(seat.roomId, seat.authorId, newSessionId)) {
      throw new Error('The room would not move this seat to its new session.');
    }
    this.pending.set(seatKey(seat.roomId, seat.authorId), {
      sessionId: newSessionId,
      ...(plan.target ? { accountHint: plan.target.id } : {}),
      ...(seedContext ? { seedContext } : {}),
    });
    this.deps.recordActivity({
      trigger: plan.trigger,
      ...(plan.by !== undefined ? { by: plan.by } : {}),
      roomId: seat.roomId,
      authorId: seat.authorId,
      entryId: plan.entryId,
      fromSessionId: old,
      toSessionId: newSessionId,
      fromAccountId: plan.current?.id ?? null,
      toAccountId: plan.target?.id ?? null,
      fromAccountLabel: plan.current ? (plan.current.label ?? plan.current.id) : null,
      toAccountLabel: plan.target ? (plan.target.label ?? plan.target.id) : null,
    });
    logger.info('[rooms] moved a seat to a fresh session', {
      roomId: seat.roomId,
      authorId: seat.authorId,
      trigger: plan.trigger,
      fromSessionId: old,
      toSessionId: newSessionId,
      toAccountId: plan.target?.id ?? null,
    });
    return { newSessionId, reason: reasonOf(plan) };
  }

  /** The summary the new session starts from; none for an expired seat's lost chat. */
  private async seedFor(
    seat: Seat,
    plan: {
      trigger: ReseatTrigger;
      current?: SeatAccount;
      alreadyPosted?: boolean;
      hideAccounts: boolean;
    }
  ): Promise<string | undefined> {
    if (plan.trigger === 'stranded' || seat.sessionId === null) return STRANDED_SEED;
    // Where outsiders can read the room, the summary names no account and no
    // account folder: the agent could repeat either (Security Must 7).
    const named = !plan.hideAccounts;
    let summary = '';
    try {
      summary = await this.deps.summaryOf({
        sessionId: seat.sessionId,
        cwd: seat.agentPath,
        accountLabel:
          (named ? (plan.current?.label ?? plan.current?.id) : undefined) ?? 'its previous account',
        accountPath: named ? (plan.current?.usage?.path ?? null) : null,
        window: plan.current?.usage?.limit?.window ?? 'five_hour',
        resetsAt: plan.current?.usage?.limit?.resetsAt ?? null,
        stoppedBecause: plan.trigger === 'limit' ? 'limit' : 'moved',
      });
    } catch (err) {
      logger.warn('[rooms] could not summarise a seat’s old session; moving it without one', {
        roomId: seat.roomId,
        authorId: seat.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (plan.trigger !== 'limit') return summary || undefined;
    const tail = CONTINUE_LINE + (plan.alreadyPosted ? ALREADY_POSTED_LINE : NOT_POSTED_LINE);
    return summary ? `${summary}\n\n${tail}` : tail;
  }
}

/** The room line's reason for a move. */
function reasonOf(plan: {
  trigger: ReseatTrigger;
  by?: string;
  current?: SeatAccount;
  target?: RankedAccount;
}): ReseatNoticeReason {
  const to = plan.target ? (plan.target.label ?? plan.target.id) : '';
  const from = plan.current ? (plan.current.label ?? plan.current.id) : null;
  switch (plan.trigger) {
    case 'stranded':
      return { kind: 'stranded' };
    case 'limit':
      return { kind: 'limit', from, to };
    case 'nearly-out':
      return { kind: 'nearly-out', from, to };
    case 'person':
      return { kind: 'by-hand', by: plan.by ?? 'Somebody', to };
  }
}

function seatKey(roomId: string, authorId: string): string {
  return `${roomId}\u0000${authorId}`;
}

function remember(seen: Set<string>, key: string): void {
  if (seen.size >= MOVED_MEMORY) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  seen.add(key);
}
