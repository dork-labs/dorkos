/**
 * The room's memory of what it has already said about itself.
 *
 * Every durable `notice` a room writes goes through here, and so does every
 * decision NOT to write one. That pairing is the reason this is one object
 * rather than three sets and a helper: a damping key is only correct next to the
 * write it damps, and the two used to sit fifty lines apart in
 * `room-trigger.ts`, which is how one key came to serve two kinds of news and
 * swallow the second (see {@link RoomNoticeLog.noticedSilence}).
 *
 * The words themselves are not here — they are in `notice-copy.ts`, in the
 * room's own voice, and this module only decides whether they are said. The
 * split matters: copy that lives inside the mechanism that happens to write it
 * is copy that drifts.
 *
 * Three memories, three lifetimes, and they are deliberately not one FIFO:
 *
 * - **Per cascade** for the guard's refusal, because "this exchange went around
 *   enough times" is a fact about one exchange, and a later one may legitimately
 *   say so again.
 * - **Per `(room, agent, reason)`** for an agent that did not answer, because
 *   every message a person sends mints its own cascade root — so a
 *   cascade-keyed memory for this would never collide with anything.
 * - **Per room** for the budget, because the budget is a property of the room.
 *
 * All three re-arm on RECOVERY rather than on a clock: the moment the state they
 * describe is over, the next occurrence is news again. No timer, no staleness,
 * nothing to tune.
 *
 * @module server/services/rooms/notices/notice-log
 */
import type { Room, RoomEntry, RoomEntryBody } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import {
  logRefusal,
  type RefusalReason,
  type RefusalVisibility,
} from '../../observability/refusals.js';
import type { AuthorRegistry } from '../author-registry.js';
import {
  buildAgentGoneNotice,
  buildAgentUnavailableNotice,
  buildBudgetNotice,
  buildBusyNotice,
  buildHaltedNotice,
  buildTurnFailedNotice,
  buildWaitingNotice,
  BUSY_CONTEXTS,
  type BusyContext,
  type WaitingKind,
} from './notice-copy.js';
import type { BudgetRefusalScope } from '../turn-budget.js';

/** The cascade a written entry belongs to. */
export interface CascadeStamp {
  root: string;
  depth: number;
}

/**
 * Why a turn produced no answer, when a member has to be told.
 *
 * Absent means the turn ran normally — a `null` `text` alongside no reason is
 * an agent that chose to stay quiet, which is conduct, not a fault, and the
 * room says nothing about it.
 *
 * - `busy` — the agent was already working, so no turn ran.
 * - `failed` — a turn ran and ended in an error, or never finished at all.
 * - `gone` — the member's directory no longer holds the agent it was added as,
 *   so no turn was even attempted. Never produced by a runner: the dispatcher
 *   decides it before a turn exists (ADR 260801-003051).
 * - `unavailable` — the room could not bind a `(room, agent)` session for this
 *   target, so no turn was even attempted. Never produced by a runner, for the
 *   same reason `gone` is not: the dispatcher decides this in `claimTargets`,
 *   before anything is claimed (DOR-1206).
 */
export type RoomTurnUnanswered = 'busy' | 'failed' | 'gone' | 'unavailable';

/** How a notice reaches the room's durable log. */
export interface RoomNoticeWriter {
  postNotice(
    roomId: string,
    body: RoomEntryBody,
    cascade: CascadeStamp,
    replyTo?: string
  ): RoomEntry;
}

/** Everything {@link RoomNoticeLog} is constructed from. */
export interface RoomNoticeLogDeps {
  writer: RoomNoticeWriter;
  /** Read-only here: used to tell a person's message from an agent's. */
  authors: AuthorRegistry;
}

/** Who a notice is about, named the way the room names them. */
export interface NoticeSubject {
  authorId: string;
  displayName: string;
}

/** What the caller knows about one silence, beyond the reason for it. */
export interface SilenceContext {
  /**
   * What the room KNOWS the agent is doing, for a `busy` reason. Ignored for
   * every other reason, which has nothing to describe.
   */
  busyWith?: BusyContext;
  /**
   * This message named this agent, even though no stored mention says so.
   *
   * The third route into {@link RoomNoticeLog.directlyAsked}, and it exists
   * because of a state the other two cannot see: a ghost claims no names, so a
   * person typing `@ana are you there?` at one produces an entry whose
   * `mentions` is EMPTY. Read through the stored list alone, the most direct
   * question in the room looks like ordinary chatter and is damped after the
   * first — the "answered 'are you there?' with silence" failure, arrived at
   * from the other side.
   *
   * **It is a third ROUTE, not a third rule**, and the distinction is the whole
   * safety of it: it is weighed only after the depth-0 and human-author guards
   * have both passed. Set beside them instead, it reopened the other half of the
   * failure this damping exists for — five AGENT-authored posts three deep in a
   * cascade, each quoting `@ana`, wrote five apologies about an agent no person
   * had asked anything. The bound that makes an undamped path safe (per
   * addressed message, and the sender sets the count) only holds while a PERSON
   * is the one addressing.
   */
  namedDirectly?: boolean;
}

/**
 * How many keys each notice memory holds before forgetting the oldest.
 *
 * Notices are deduped in memory rather than by querying the log, because "has
 * the room already said Ana is busy?" is a question about a JSON body, and one
 * bounded set beats a `LIKE` over every entry. Losing a set on restart costs at
 * most one repeated line.
 */
const NOTICE_MEMORY = 512;

/**
 * What a room has already said about itself, and what it says next.
 *
 * Construction is cheap and side-effect free: an install with no rooms in it
 * pays for four empty sets.
 */
export class RoomNoticeLog {
  private readonly deps: RoomNoticeLogDeps;

  /**
   * `(room, cascade, agent)` triples a CASCADE refusal notice has already
   * named. Bounded FIFO: a cascade is short-lived, so forgetting the oldest
   * costs at most one repeated line.
   *
   * Per CASCADE is the right lifetime for this one and the wrong one for
   * {@link RoomNoticeLog.noticedSilence} — see its doc. The rooms spec says so
   * directly: "one notice per agent per cascade, not per refusal… a later
   * cascade may legitimately notice again."
   */
  private readonly noticedCascades = new Set<string>();

  /**
   * `(room, author, reason)` triples the room has already reported as not
   * answering — one memory per REASON, not one per agent.
   *
   * **Keyed on the agent, NOT the cascade, and that is the whole point.** Every
   * message a person sends starts its own cascade root, so a cascade-keyed
   * memory never collides for this case: four agent-driven re-triggers of a busy
   * agent produced four identical apologies while the doc beside them claimed
   * one.
   *
   * **A person asking again is never damped by it**, and that exception is the
   * other half of the rule rather than a hole in it — see
   * {@link RoomNoticeLog.reportSilence}. The set exists to stop AGENTS
   * generating apologies; a person who types "are you there?" into a silent room
   * is owed an answer, and swallowing it produced exactly the dead air this
   * whole memory was meant to prevent.
   *
   * **The reason is in the key because the two are different news.** They used
   * to share one key, which was harmless only while a busy refusal and a failure
   * could not both be true of one live turn. They can now: a trigger refused
   * because the agent is mid-turn writes a busy line, and then THAT turn crashes
   * — and a shared key swallowed the `turn_failed` line, so the room's last word
   * was an invitation to wait for an agent that had already fallen over.
   * `failed` no longer consults the set at all (each error is distinct news,
   * room-participation spec §5.2), but it still records into it, because a
   * recorded failure is what a later busy line reads.
   *
   * Re-armed on recovery rather than on a clock, the way
   * {@link RoomNoticeLog.noticedBudget} re-arms: the moment that agent takes a
   * turn in that room and the room actually gets its OUTCOME — an answer, a
   * refusal, or a decision to stay quiet — EVERY reason's block is over and the
   * next one is news again.
   */
  private readonly noticedSilence = new Set<string>();

  /**
   * `(room, agent)` pairs the room has already said are parked on a person.
   *
   * The shortest-lived memory here, and the shortest on purpose: it is cleared
   * when the TURN ends ({@link RoomNoticeLog.turnEnded}), not when the room next
   * hears from the agent. A turn that stops twice for two approvals says so
   * once; the next turn that stops says so again, because a second wait a person
   * has not been told about is exactly the forty-one minutes of silence this
   * notice exists to prevent (DOR-784).
   */
  private readonly noticedWaiting = new Set<string>();

  /**
   * Rooms that have already been told they are out of budget.
   *
   * Separate from the sets above, with a different lifetime and a different key
   * shape, because it answers a different question. Sharing one FIFO meant
   * budget keys were evicted non-deterministically by ordinary refusal traffic,
   * AND — worse — a room that was told once was never told again, since nothing
   * ever cleared the entry. A room silently refusing to reply after its first
   * hour is exactly the state a notice exists to prevent.
   *
   * Cleared the moment the room can spend again
   * ({@link RoomNoticeLog.budgetRecovered}), so the next exhaustion speaks up.
   * No clock needed: recovery IS the re-arm.
   */
  private readonly noticedBudget = new Set<string>();

  /**
   * Rooms that have already been told everything in them was stopped.
   *
   * Keyed on the room and re-armed by the next claim, for the reason the budget
   * memory is: a second Stop press in a room where nothing has happened since
   * the first is the same question asked twice, and two identical lines about it
   * are the over-participation this whole module damps. The moment an agent
   * starts working there again, a halt is news again.
   */
  private readonly noticedHalt = new Set<string>();

  constructor(deps: RoomNoticeLogDeps) {
    this.deps = deps;
  }

  /**
   * Say that an agent did not answer here — damped against agents, never
   * against the person asking.
   *
   * Three rules, and each one is a defect that reached a real room:
   *
   * 1. **A repeat that nobody directed at this agent is damped**, on
   *    `(room, agent, reason)` and never the cascade. Two kinds of traffic land
   *    here: an agent's reply re-triggering a busy colleague, which mints a
   *    fresh cascade root per hop so a cascade-keyed memory never collides; and
   *    a person's ORDINARY chatter reaching an `engaged` agent, which is the
   *    channel default and triggers that agent on every message for the length
   *    of its window. Neither asked this agent anything, and a line apiece is
   *    the over-participation the whole domain damps.
   * 2. **A message that ASKED this agent is never damped** — see
   *    {@link RoomNoticeLog.directlyAsked}. Leaving this out turned "say it
   *    once" into "say it once, ever": a room was observed answering "@X are
   *    you there?" with total silence, twice, because a busy line minutes
   *    earlier had armed the key and nothing had cleared it.
   *
   *    A direct question deserves a direct answer, every time it is asked. This
   *    cannot become a flood, because the bound is per ADDRESSED message and the
   *    sender is the one addressing: one dispatch triggers each agent once, so
   *    somebody gets back exactly as many lines as they wrote messages naming
   *    that agent. Nothing an agent does can inflate that count.
   * 3. **A failure is never damped either**, whoever triggered it
   *    (room-participation spec §5.2: each error is distinct news). A busy line
   *    can be a repeat of a state that has not changed; a turn that crashed is
   *    an event that just happened, and swallowing the second one leaves the
   *    room's last word describing a fault that has since been superseded.
   *
   *    `gone` damps like `busy` rather than like `failed`, and for the reason
   *    rule 1 gives: an agent that is not installed any more is a STATE, and it
   *    is the most persistent one here — every ordinary message in a channel
   *    where an `engaged` ghost sits would otherwise write another line saying
   *    the same unchanged thing. A person who names it still gets an answer
   *    every time they ask.
   *
   *    `unavailable` damps the same way, for a narrower reason: the one
   *    reachable cause is database contention on the `(room, agent)` session
   *    row, which a retry (the next message) routinely clears — so a burst of
   *    triggers that all land on the same contention is one line, not one per
   *    trigger, and a person who names the agent directly still gets told every
   *    time (DOR-1206).
   *
   * Every block clears the moment that agent's turn there reaches an OUTCOME —
   * {@link RoomNoticeLog.recovered}.
   *
   * @param room - The room the trigger was refused in.
   * @param entry - The entry whose trigger produced no answer.
   * @param agent - Who did not answer, named as the room names it. Deliberately
   *   not a claimed target: a trigger refused before it was claimed never became
   *   one, and it owes the same line as a turn that ran and could not.
   * @param reason - Why it stayed quiet, which picks the words.
   * @param dispatchId - The dispatch this refusal belongs to, or `null` when
   *   there is none. Required rather than ambient, and required rather than
   *   optional: a refusal decided in `claimTargets` runs synchronously inside
   *   `RoomService.post`, which for an agent's reply is inside the REPLYING
   *   agent's dispatch scope — so the ambient id there names somebody else.
   *   Every call site has to say which it is.
   * @param context - What else is known: what a busy agent is doing, and
   *   whether this message named it by a string no stored mention records.
   */
  reportSilence(
    room: Room,
    entry: RoomEntry,
    agent: NoticeSubject,
    reason: RoomTurnUnanswered,
    dispatchId: string | null,
    context: SilenceContext = {}
  ): void {
    const busyWith = context.busyWith ?? 'unknown';
    const key = silenceKey(room.id, agent.authorId, dampReason(reason, busyWith));
    const asked = this.directlyAsked(room, entry, agent.authorId, context.namedDirectly === true);
    const damped = reason !== 'failed' && !asked && this.noticedSilence.has(key);
    // Every refusal, damped ones included. A room that went forty-one minutes
    // saying nothing left three lines in the log to explain it, and the two
    // silences that mattered most — the ones a damping key swallowed — left
    // none at all.
    //
    // **The level follows the visibility, and that is the whole amendment.** A
    // damped refusal is one the person was never told about, so this line is the
    // only place it exists; filing it at `info` beside the ones they DID see
    // makes it invisible a second time.
    const record = (visibility: RefusalVisibility): void =>
      logRefusal('[rooms] an agent did not answer', {
        reason: REFUSAL_FOR_SILENCE[reason],
        visibility,
        dispatchId,
        roomId: room.id,
        authorId: agent.authorId,
        entryId: entry.id,
        detail: {
          cascadeRoot: entry.cascadeRoot,
          ...(reason === 'busy' ? { busyWith } : {}),
        },
      });
    if (damped) {
      record('damped');
      return;
    }
    const body = SILENCE_BODIES[reason](agent, busyWith);
    // Reported AFTER the write, so `visibility` says what actually happened
    // rather than what was intended: a notice the room could not write (an
    // archive between the post and the notice) leaves the person as uninformed
    // as a damped one, and the line has to say so.
    const written = this.writeNotice(room, entry, agent.authorId, body);
    record(written ? 'shown' : 'silent');
    if (written) {
      // Recorded even when it was never consulted. A failure that writes
      // unconditionally still arms the key a LATER busy line reads, which is
      // what keeps "one busy line per state" true after an error.
      remember(this.noticedSilence, key);
    }
  }

  /**
   * Say, once per turn, that an agent has stopped and is waiting on a person.
   *
   * **This is the incident's own notice.** On 2026-07-31 agents in a room sat
   * silent for up to forty-one minutes because their turns had stopped on a
   * tool-approval prompt that only their own session showed. The room said
   * nothing, the log said nothing, and ten minutes later each prompt auto-denied
   * — so from inside the room a working agent and a broken one looked identical.
   * A turn parked on a person is a turn that will produce nothing until that
   * person acts, and the room is where they are.
   *
   * Damped on `(room, agent)` for the life of the TURN, not the life of the
   * conversation: a turn that stops twice says so once, and the next turn that
   * stops says so again. {@link RoomNoticeLog.turnEnded} is what clears it, so
   * the key cannot outlive the wait it describes.
   *
   * @param room - The room whose turn is parked.
   * @param entry - The entry that triggered the turn, for the cascade stamp.
   * @param agent - The agent that is waiting.
   * @param waiting.kind - What sort of answer it is waiting for; picks the words.
   * @param waiting.toolName - The tool an approval is about, for the log only.
   */
  reportWaiting(
    room: Room,
    entry: RoomEntry,
    agent: NoticeSubject,
    waiting: { kind: WaitingKind; toolName?: string }
  ): void {
    const key = agentNoticeKey(room.id, agent.authorId);
    const damped = this.noticedWaiting.has(key);
    // Not a refusal — nothing was declined, the turn is simply parked — so it
    // keeps `info` and stays outside `logRefusal`. It carries `damped` for the
    // same reason a refusal carries `visibility`: a wait nobody was told about
    // is the forty-one minutes this notice exists to prevent.
    logger.info('[rooms] a turn stopped to wait for a person', {
      roomId: room.id,
      authorId: agent.authorId,
      kind: waiting.kind,
      ...(waiting.toolName !== undefined ? { toolName: waiting.toolName } : {}),
      damped,
      entryId: entry.id,
    });
    if (damped) return;
    const body = buildWaitingNotice(agent.displayName, agent.authorId, waiting.kind);
    if (this.writeNotice(room, entry, agent.authorId, body)) remember(this.noticedWaiting, key);
  }

  /**
   * Say once, per agent per cascade, that the guard stopped an exchange.
   *
   * Per cascade because that is what the rule is about: this conversation went
   * around enough times, and a later one may legitimately say so again (rooms
   * spec §6). Deliberately a different memory from
   * {@link RoomNoticeLog.noticedSilence}, which answers a different question
   * with a different lifetime.
   *
   * @param room - The room the refusal happened in.
   * @param entry - The entry whose trigger was refused.
   * @param authorId - The agent that was refused.
   * @param body - The notice copy, from `notice-copy.ts`.
   * @param cause - Which guard rule refused, for the log.
   * @param dispatchId - The dispatch this refusal belongs to, or `null` when
   *   there is none — which is every reachable case today, since a target the
   *   guard refuses is never claimed and so never mints one.
   */
  announce(
    room: Room,
    entry: RoomEntry,
    authorId: string,
    body: RoomEntryBody,
    cause: 'cascade_depth' | 'cascade_ancestry',
    dispatchId: string | null
  ): void {
    const key = cascadeNoticeKey(room.id, entry.cascadeRoot, authorId);
    const record = (visibility: RefusalVisibility): void =>
      logRefusal('[rooms] the guard stopped an exchange', {
        reason: cause,
        visibility,
        dispatchId,
        roomId: room.id,
        authorId,
        entryId: entry.id,
        detail: { cascadeRoot: entry.cascadeRoot, cascadeDepth: entry.cascadeDepth },
      });
    if (this.noticedCascades.has(key)) {
      record('damped');
      return;
    }
    // Remembered only once it is actually in the log. Marking first meant a
    // cascade whose FIRST notice threw went silent for good — precisely the
    // state the notice exists to prevent.
    const written = this.writeNotice(room, entry, authorId, body);
    record(written ? 'shown' : 'silent');
    if (written) remember(this.noticedCascades, key);
  }

  /**
   * Say once, per exhaustion, that the room is out of automatic turns.
   *
   * Keyed on the ROOM rather than the cascade, because the budget is a property
   * of the room: a caller minting a fresh cascade per message would otherwise
   * get a fresh notice per message, turning the thing that reports a flood into
   * part of it. Re-armed as soon as the room can spend again, so "once" means
   * once per exhaustion and not once ever.
   *
   * @param room - The room that ran out.
   * @param entry - The entry whose trigger could not be afforded.
   * @param scope - Which cap refused, so the copy points at the right setting.
   * @param dispatchId - The dispatch this refusal belongs to. Unlike the guard's,
   *   a budget refusal DOES have one: the target has already survived the guard
   *   and been given an id by the time the room is asked to afford it.
   */
  reportBudget(
    room: Room,
    entry: RoomEntry,
    scope: BudgetRefusalScope,
    dispatchId: string | null
  ): void {
    const record = (visibility: RefusalVisibility): void =>
      logRefusal('[rooms] the room is out of automatic turns', {
        reason: 'room_budget',
        visibility,
        dispatchId,
        roomId: room.id,
        entryId: entry.id,
        detail: { scope },
      });
    if (this.noticedBudget.has(room.id)) {
      record('damped');
      return;
    }
    const written = this.writeNotice(room, entry, null, buildBudgetNotice(scope));
    record(written ? 'shown' : 'silent');
    if (written) this.noticedBudget.add(room.id);
  }

  /**
   * Write one notice into the room, reporting whether it landed.
   *
   * @param room - The room it belongs in.
   * @param entry - The entry it is about, for the cascade stamp and the thread.
   * @param authorId - Who the notice is about, for the failure log. `null` when
   *   it is about the room rather than a member.
   * @param body - The notice copy.
   * @returns `false` when the write failed, so no caller records a line the
   *   room never got.
   */
  private writeNotice(
    room: Room,
    entry: RoomEntry,
    authorId: string | null,
    body: RoomEntryBody
  ): boolean {
    // Reported where the exchange happened. A refusal at the channel's top
    // level, about a back-and-forth three replies deep inside a thread, is a
    // notice the reader cannot connect to anything.
    return this.write(room.id, body, authorId, {
      cascade: { root: entry.cascadeRoot, depth: entry.cascadeDepth },
      ...(entry.threadRootEntryId !== null ? { replyTo: entry.threadRootEntryId } : {}),
    });
  }

  /**
   * Put one notice on the room's log, reporting whether it landed.
   *
   * **The single writer, and it is single on purpose.** Every notice in this
   * domain goes through here, so the failure handling below is written once and
   * cannot drift — a second call site that hand-rolled its own `try` was the
   * shape that let a halt in an archived room throw where every other notice
   * degraded (`.claude/rules/room-conduct.md`, "a refusal is visible").
   *
   * @param roomId - The room the notice belongs to.
   * @param body - The notice copy, from `notice-copy.ts`.
   * @param about - Who it is about, for the failure log. `null` when it is about
   *   the room rather than a member.
   * @param where.cascade - The cascade to stamp it with.
   * @param where.replyTo - The thread it belongs under, when it belongs in one.
   * @returns `false` when the write failed.
   */
  private write(
    roomId: string,
    body: RoomEntryBody,
    about: string | null,
    where: { cascade: CascadeStamp; replyTo?: string }
  ): boolean {
    try {
      this.deps.writer.postNotice(roomId, body, where.cascade, where.replyTo);
      return true;
    } catch (err) {
      // Refusals are evaluated synchronously inside `post`, so a throw here
      // would surface as a failure of the message that was already committed —
      // the poster would see their own successful post 500. The room being
      // archived between the post and the notice is the reachable case.
      logger.warn('[rooms] could not write a room notice', {
        roomId,
        authorId: about,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Say that somebody stopped everything running in this room.
   *
   * Damped on the ROOM, and re-armed by the next claim
   * ({@link RoomNoticeLog.workStarted}) rather than by a clock — the same shape
   * the budget memory uses, for the same reason. Pressing Stop twice in a room
   * that is already quiet is one question asked twice, and answering it twice
   * puts the thing that reports over-participation into it.
   *
   * The notice is stamped as its OWN cascade: a halt answers no message, so
   * inheriting the provenance of one would put it inside an exchange it had
   * nothing to do with.
   *
   * @param room - The room that was stopped.
   * @param stopped - How many in-flight turns were interrupted. `0` is a real
   *   answer and still speaks: it says the room was already idle.
   */
  reportHalted(room: Room, stopped: number): void {
    if (this.noticedHalt.has(room.id)) return;
    if (
      this.write(room.id, buildHaltedNotice(stopped), null, {
        cascade: { root: room.id, depth: 0 },
      })
    ) {
      this.noticedHalt.add(room.id);
    }
  }

  /**
   * An agent started working in this room, so a halt is worth reporting again.
   *
   * Recovery IS the re-arm, exactly as it is for the budget: what makes a second
   * halt notice a repeat is that nothing has happened since the first one, and a
   * claim being taken is precisely something happening.
   *
   * @param roomId - The room a claim was just taken in.
   */
  workStarted(roomId: string): void {
    this.noticedHalt.delete(roomId);
  }

  /**
   * An agent's turn in this room reached an outcome, so every block on saying it
   * went quiet is over.
   *
   * Recovery IS the re-arm: the next time it cannot answer, the room says so
   * again — for every reason, because an answer landing is evidence against all
   * of them at once.
   *
   * @param roomId - The room the turn ran in.
   * @param authorId - The agent that answered, refused, or chose to stay quiet.
   */
  recovered(roomId: string, authorId: string): void {
    for (const reason of SILENCE_REASONS) {
      if (reason !== 'busy') {
        this.noticedSilence.delete(silenceKey(roomId, authorId, reason));
        continue;
      }
      // `busy` damps per CONTEXT, so recovery has to clear per context too —
      // see {@link dampReason}. Enumerated rather than pattern-matched, so a new
      // context cannot be left armed past its own recovery.
      for (const busyWith of BUSY_CONTEXTS) {
        this.noticedSilence.delete(silenceKey(roomId, authorId, dampReason(reason, busyWith)));
      }
    }
  }

  /**
   * An agent's turn in this room ended, however it ended.
   *
   * Only the waiting memory clears here, and the narrowness is the point: a turn
   * that ended is a wait that is over, whether the person answered the prompt or
   * it timed out. Whether the agent went QUIET is a different question with a
   * different answer, settled by {@link RoomNoticeLog.recovered}.
   *
   * @param roomId - The room the turn ran in.
   * @param authorId - The agent whose turn ended.
   */
  turnEnded(roomId: string, authorId: string): void {
    this.noticedWaiting.delete(agentNoticeKey(roomId, authorId));
  }

  /**
   * The room can spend on automatic turns again, so the next exhaustion is news.
   *
   * @param roomId - The room that just reserved a turn.
   */
  budgetRecovered(roomId: string): void {
    this.noticedBudget.delete(roomId);
  }

  /**
   * Whether a person put THIS agent's name on this message.
   *
   * The narrow reading, and the narrowness is the point. An earlier revision
   * asked only "did a human write this, at depth 0", which is every message
   * anybody types — and `engaged` is the channel default, so an agent addressed
   * once stays triggerable by ordinary chatter for the length of its window.
   * Four unrelated messages while one agent ran late produced four apologies
   * about an agent nobody had asked anything. That is the flood this damping
   * exists to prevent, arrived at from the other side.
   *
   * Three conditions:
   *
   * - **Depth 0**, so an agent cannot buy itself an exemption. An agent's own
   *   post inherits the turn it was made inside, and an un-provenanced one is
   *   stamped at the ceiling by `deriveCascade` — but that rule lives in another
   *   module, and this costs one comparison to not depend on it.
   * - **Written by a human.** Not the same question as depth 0: a community's
   *   cached remote members will fill this table with other people
   *   (ADR 260727-184933 D6), and the rule should still read correctly then.
   * - **Addressed to this agent** — named in `entry.mentions`, or in a direct
   *   message, where every message a person sends is addressed to whoever is on
   *   the other side and no `@` is needed to mean it. A third route exists for
   *   the one case a stored mention cannot record — see
   *   {@link SilenceContext.namedDirectly}.
   *
   * `mentions` is the resolved list stored at write time, never a re-parse of
   * the text (`.claude/rules/room-conduct.md`), so this asks exactly the question
   * addressing asked and cannot drift from it.
   *
   * @param room - The room the message landed in; its kind decides the DM case.
   * @param entry - The entry whose trigger is being refused.
   * @param agentAuthorId - The agent that did not answer.
   * @param namedDirectly - The caller saw this message name this agent by a
   *   string no stored mention records. **Weighed AFTER the two guards above,
   *   never instead of them** — see {@link SilenceContext.namedDirectly}.
   */
  private directlyAsked(
    room: Room,
    entry: RoomEntry,
    agentAuthorId: string,
    namedDirectly = false
  ): boolean {
    if (entry.cascadeDepth !== 0) return false;
    if (this.deps.authors.getById(entry.authorId)?.kind !== 'human') return false;
    return room.kind === 'dm' || entry.mentions.includes(agentAuthorId) || namedDirectly;
  }
}

/**
 * Separator for a notice-memory key. Named, rather than a literal in a template,
 * because it used to be an invisible NUL that a doc comment described as a space
 * — and the next reader wrote a lookup against the space.
 */
const NOTICE_KEY_SEPARATOR = '\u0000';

/**
 * The `(room, agent)` identity, for map keys only. Nothing parses it back apart.
 *
 * The grain of what the room has already said about ONE agent in ONE room. The
 * absence of a cascade is the design: every message a person sends starts its
 * own, so a cascade in this key would never collide with anything.
 */
function agentNoticeKey(roomId: string, authorId: string): string {
  return [roomId, authorId].join(NOTICE_KEY_SEPARATOR);
}

/**
 * A `(room, agent, reason)` key: whether the room has already said THIS about
 * why that agent did not answer. One memory per reason, so a busy line and a
 * failure line each get their own "once".
 */
function silenceKey(roomId: string, authorId: string, reason: string): string {
  return [roomId, authorId, reason].join(NOTICE_KEY_SEPARATOR);
}

/**
 * What a silence damps AGAINST — the reason, and for `busy` the context too.
 *
 * **`busy` alone is not one state, and treating it as one hid a line.** Two very
 * different things reach it: a stranger holding the agent's own session
 * (`unknown`), and this room giving up on a message that had been waiting on the
 * agent for the best part of an hour (`held-too-long`). Under one key an
 * un-recovered `unknown` swallowed the expiry line — and for an UNDIRECTED
 * message (an engaged seat, no `@mention`, not a DM) nothing re-armed it, so the
 * lane promised an answer, cleared, and the room said nothing at all. That is
 * the invisible refusal `.claude/rules/room-conduct.md` forbids.
 *
 * Splitting the key keeps the anti-spray property inside each context — a second
 * expiry before the agent answers again is still one line — while stopping one
 * state from speaking for the other.
 *
 * @param reason - Why the turn produced nothing.
 * @param busyWith - What the room knows it was doing. Read only for `busy`.
 */
function dampReason(reason: RoomTurnUnanswered, busyWith: BusyContext): string {
  return reason === 'busy' ? `${reason}:${busyWith}` : reason;
}

/**
 * A `(room, cascade, agent)` key: whether this exchange has already been told
 * that the guard stopped it here. Cascade-scoped because the guard's rule is —
 * a later exchange may legitimately say so again.
 */
function cascadeNoticeKey(roomId: string, cascadeRoot: string, authorId: string): string {
  return [roomId, cascadeRoot, authorId].join(NOTICE_KEY_SEPARATOR);
}

/**
 * Every reason a silence can be reported for, so recovery can clear them all
 * without a caller remembering to list them.
 *
 * **Written as a keyed object because that is the only shape the compiler
 * checks for completeness.** The obvious version — a `readonly RoomTurnUnanswered[]`
 * array, however it is asserted — only ever proves that each element BELONGS to
 * the union, which `['busy']` satisfies just as happily as this does. A missing
 * reason there compiles clean and costs a person the notice it was meant to
 * re-arm: that agent's block would outlive its recovery and stay silent for
 * good. `Record<RoomTurnUnanswered, true>` is the assertion that runs the other
 * way — every member must appear — so adding a reason to the union without
 * adding it here is a type error at this line rather than a bug in a room.
 */
const SILENCE_REASONS = Object.keys({
  busy: true,
  failed: true,
  gone: true,
  unavailable: true,
} satisfies Record<RoomTurnUnanswered, true>) as RoomTurnUnanswered[];

/**
 * The words each reason writes into the room, as a total map for the reason
 * {@link SILENCE_REASONS} is a keyed object: a reason added to the union without
 * words here is a type error at this line, not an agent that goes quiet with no
 * notice at all.
 */
const SILENCE_BODIES: Record<
  RoomTurnUnanswered,
  (agent: NoticeSubject, busyWith: BusyContext) => RoomEntryBody
> = {
  busy: (agent, busyWith) => buildBusyNotice(agent.displayName, agent.authorId, busyWith),
  failed: (agent) => buildTurnFailedNotice(agent.displayName, agent.authorId),
  gone: (agent) => buildAgentGoneNotice(agent.displayName, agent.authorId),
  unavailable: (agent) => buildAgentUnavailableNotice(agent.displayName, agent.authorId),
};

/**
 * Which closed-union refusal reason each silence is filed under, total for the
 * same reason: `jq 'group_by(.reason)'` has to be able to tell a busy agent from
 * a crashed one from one that is not installed any more.
 */
const REFUSAL_FOR_SILENCE: Record<RoomTurnUnanswered, RefusalReason> = {
  busy: 'agent_busy',
  failed: 'turn_failed',
  gone: 'agent_gone',
  unavailable: 'session_bind_failed',
};

/**
 * Record a key, evicting the oldest when the set is full.
 *
 * Bounded because these sets are only ever added to by traffic: a room nobody
 * is watching should not be able to grow one without limit.
 *
 * @param seen - The FIFO set to record into.
 * @param key - The key that just earned its place.
 */
function remember(seen: Set<string>, key: string): void {
  if (seen.size >= NOTICE_MEMORY) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  seen.add(key);
}
