import { restoreHandoff, durableHandoffStatus } from './handoff-recovery-view.js';
import type { DbTransaction } from '@dorkos/db';
import { buildHandoffNotice } from '../notices/notice-copy.js';
import {
  roomLabel,
  seatPrompt,
  handoffReceipt,
  renderPostedHandoff,
  type RoomHandoff,
  type HandoffOrigin,
  type HandoffOutcome,
} from './handoff-presentation.js';
export type { RoomHandoff, HandoffOrigin, HandoffOutcome } from './handoff-presentation.js';
import { admitPublicHandoff, type HandoffDraftInput } from './handoff-admission.js';
import { decodeHandoffEnvelope, joinHandoffCurrentCarry } from './handoff-envelope.js';
import {
  flushOriginalRoomNotices,
  type HandoffRoomNoticeWriter,
} from './handoff-terminal-notices.js';
/**
 * One seat per agent per room, and the hand-off between them (DOR-3397, room coordination item 4).
 *
 * **Only an agent's seat posts in a room.** The seat is the session the room keeps for that
 * `(room, agent)` pair: the one its turns there run on. On the 0.126.4 release day a second
 * session of one agent brought a stopped plan back into #dorkos three times, because any chat of
 * an agent could post into any room it was in. Now a `post_to_room` from any other session of
 * that agent becomes a hand-off to its seat there.
 *
 * **A hand-off is a turn in the seat.** It carries the draft, who asked for it, the room it came
 * from and the drafting chat's marks. The seat's turn re-reads the room (the stale-post check,
 * DOR-3398, holds its post until it has), then posts the draft or a better one, or posts nothing
 * and says why. A `verbatim` hand-off may be refused but not edited. The post reads "Shared from
 * #X at Y's request", or "Shared from #X" when nobody asked.
 *
 * **It routes a post and adds no ask.** Nothing here waits on a person, at any level, Full
 * included. The seat's turn runs under every bound a room turn has (one session per room, one
 * working tree per agent, the room's turn budget), so a busy seat queues the hand-off and runs it
 * when it is free (scenario B), and two hand-offs to one seat run one after the other (F). The
 * drafting chat's marks ride the seat's turn as its ceiling, so a stranger's words stay held (E).
 *
 * **No auto-join.** An agent that is not in the room is refused, and told to ask the operator,
 * who can post it or add it: joining a room for it would grant access nobody gave.
 *
 * Accepted public drafts retain original admission/deadline in SQLite. Only queued work resumes
 * after restart; ambiguous attempts end interrupted. Status remains durable, and a closed
 * source adapter may notify the original permitted chat without ordinary chat_send.
 *
 * @module server/services/rooms/handoff/room-handoff
 */
import { logHandoffFailure, type HandoffTrace } from './failure-trace.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../../../lib/logger.js';
import type { AuthorRecord } from '../author-registry.js';
import { resolveOperatorAuthor } from '../operator-author.js';
import { agentKey } from '../room-claims.js';
import { nameForAgents } from '../room-context.js';
import { RoomError } from '../room-errors.js';
import type { AsideResult } from '../room-trigger/aside.js';
import { roomStartAnchor } from '../room-trigger/room-start-anchor.js';
import type { RoomCore } from '../service/room-core.js';
import { declineReason, noticeReason } from './decline-reason.js';
import { HandoffOutcomes, type HandoffStatus } from './handoff-outcomes.js';
import { HandoffQueue, handoffRetryDelay } from './handoff-queue.js';
import { withRoomMarks } from './seat-carry.js';
import { RoomSeatReports } from './seat-report.js';

/** The longest a hand-off waits for a busy seat before it gives up and says so. */
export const HANDOFF_WAIT_MAX_MS = 60 * 60_000;
const WAIT_EXPIRED =
  'The seat stayed busy for an hour. Continue in a chat that can receive messages.';

/** Whether two drafts are the same words, ignoring the space around them. */
function sameWords(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** Every agent's seats and the hand-offs between them, for one room service. */
export class RoomHandoffs {
  /** Each seat's queue, so two hand-offs to one seat run one after the other (F). */
  private readonly queue: HandoffQueue<RoomHandoff>;
  private readonly owned = new Map<string, RoomHandoff>();
  private stopped = false;
  private booted = false;
  private readonly bootOwner = randomUUID();
  private notifyTerminals: () => void = () => {};
  /** The hand-off a seat is running right now, by `(room, agent)`. */
  private readonly running = new Map<string, RoomHandoff>();
  /** Spin-off reports into the seat that started them (DOR-3488). */
  readonly reports: RoomSeatReports;
  /** How each hand-off stands, by the id its sender holds (DOR-3778). */
  readonly outcomes = new HandoffOutcomes();

  /**
   * Build the seats and hand-offs for one room service.
   *
   * @param core - The room service's shared state.
   */
  constructor(
    private readonly core: RoomCore,
    private readonly postOriginalNotice: HandoffRoomNoticeWriter
  ) {
    this.reports = new RoomSeatReports(core);
    this.queue = new HandoffQueue({
      run: (handoff) => this.run(handoff),
      expired: (handoff) => this.decline(handoff, WAIT_EXPIRED),
      cancelled: (handoff) => this.cancelWaiting(handoff),
      failed: (handoff) =>
        this.decline(handoff, 'The hand-off could not run. Read its status before trying again.'),
    });
  }

  /**
   * Whether `sessionId` is this agent's seat in this room: the session its live turn there runs
   * on, or the one the room keeps for it, under either of its ids (a session is renamed mid-turn).
   *
   * @param roomId - The room.
   * @param authorId - The agent.
   * @param sessionId - The session the call came from, as the surface verified it.
   */
  isSeat(roomId: string, authorId: string, sessionId: string): boolean {
    const turn = this.core.triggers.activeTurnHere(roomId, authorId);
    if (turn?.sessionId === sessionId) return true;
    if (this.core.store.getRoomSession(roomId, authorId) === sessionId) return true;
    // A first turn runs on the id the room minted for it until the runtime renames it, and the
    // ledger follows the rename, so no "not named yet" fallback is needed (Security, DOR-3397).
    const binding = this.core.store.sessionLedger.bindingForSession(sessionId);
    return binding?.roomId === roomId && binding.authorId === authorId;
  }

  /**
   * The hand-off this seat's live turn is running, if its turn is one.
   *
   * @param roomId - The room.
   * @param authorId - The agent.
   */
  runningFor(roomId: string, authorId: string): RoomHandoff | undefined {
    const handoff = this.running.get(agentKey(roomId, authorId));
    if (handoff?.dispatchId === undefined || handoff.postedEntryId !== undefined) return undefined;
    return this.core.triggers.dispatchFor(roomId, authorId) === handoff.dispatchId
      ? handoff
      : undefined;
  }

  /**
   * The seat rule, before a post is written. A post from a session that is not the agent's seat
   * in that room is handed to the seat, and the sender gets the receipt back. A seat running a
   * hand-off posts the draft's words (unchanged, on a verbatim one) with the line that says where
   * they came from, in the sender's thread. Anything else posts as written. A caller with no
   * verified session (the external server) has no seat to compare, and posts as written.
   *
   * @param author - Who is posting, as the capability resolved them.
   * @param input - The post as the tool was called.
   * @param sessionId - The session the call came from, as the surface verified it.
   * @returns The tool result to return instead of posting, or what to post.
   */
  async gate(
    author: AuthorRecord,
    input: { roomId: string; text: string; replyTo?: string; verbatim?: boolean },
    sessionId: string | undefined
  ): Promise<
    { result: Record<string, unknown> } | { text: string; replyTo?: string; handoff?: RoomHandoff }
  > {
    const asWritten = {
      text: input.text,
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    };
    if (author.kind !== 'agent' || sessionId === undefined) return asWritten;
    if (!this.isSeat(input.roomId, author.id, sessionId)) {
      return {
        result: await this.handOff({
          roomId: input.roomId,
          author,
          text: input.text,
          ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
          verbatim: input.verbatim === true,
          callerSessionId: sessionId,
        }),
      };
    }
    const handoff = this.runningFor(input.roomId, author.id);
    if (handoff === undefined) return asWritten;
    if (handoff.verbatim && !sameWords(input.text, handoff.draft)) {
      return {
        result: {
          posted: false,
          reason: 'verbatim',
          instruction:
            'Not posted: this hand-off is word for word. Post the draft exactly as written, ' +
            'or post nothing and say why.',
        },
      };
    }
    return renderPostedHandoff(handoff, input);
  }

  /**
   * Record that the seat posted its hand-off.
   *
   * @param handoff - The hand-off.
   * @param entryId - What it posted.
   */
  notePosted(handoff: RoomHandoff, entryId: string): void {
    handoff.postedEntryId = entryId;
    this.signalTerminals();
  }

  /**
   * Hand a post from a session that is not the agent's seat in that room to the seat.
   *
   * @param input.roomId - The room the post was for.
   * @param input.author - The agent.
   * @param input.text - The draft.
   * @param input.replyTo - The thread it was for, when named.
   * @param input.verbatim - Whether the seat may refuse but not edit it.
   * @param input.callerSessionId - The session the post came from.
   * @returns What the sender's tool call answers.
   * @throws {RoomError} `ROOM_NOT_FOUND` when the agent is not in that room (scenario D).
   */
  async handOff(input: HandoffDraftInput): Promise<Record<string, unknown>> {
    const acceptedAt = Date.now();
    if (!this.booted || this.stopped)
      return {
        posted: false,
        handedOff: false,
        reason: 'DorkOS is starting or stopping, so it can’t take hand-offs. Try again soon.',
      };
    const { roomId, author } = input;
    // The same answer for a room that does not exist and one the agent is not in, so a room id
    // cannot be probed; the operator can see every room, so naming them gives nothing away.
    if (this.core.store.getMember(roomId, author.id) === null) {
      const operator = nameForAgents(this.core, resolveOperatorAuthor(this.core.authors).id);
      throw new RoomError(
        'ROOM_NOT_FOUND',
        `You are not in that room, so you cannot post there, and DorkOS will not add you. ` +
          `Ask ${operator ?? 'the operator'}: they can post it or add you.`
      );
    }
    const key = agentKey(roomId, author.id);
    const queued = this.queue.has(key);
    const admitted = this.queue.admit(key, acceptedAt + HANDOFF_WAIT_MAX_MS, () => {
      const handoff = admitPublicHandoff(
        this.core,
        input,
        { acceptedAt, waitDeadlineAt: acceptedAt + HANDOFF_WAIT_MAX_MS },
        () => this.originOf(input.callerSessionId, author.id)
      );
      this.outcomes.noteWaiting(
        handoff.id,
        author.id,
        queued ? 'queued' : 'running',
        handoff.waitDeadlineAt
      );
      return handoff;
    });
    if (!admitted.accepted)
      return {
        posted: false,
        handedOff: false,
        ...(admitted.why === 'invalid'
          ? {
              reason: 'admission-policy-unavailable',
              instruction:
                'DorkOS can’t tell what this turn may do yet. Start a new turn, then hand it off.',
            }
          : {
              reason:
                admitted.why === 'capacity'
                  ? 'Too many hand-offs are waiting. Continue in a permitted direct chat.'
                  : 'This hand-off could not be accepted. Continue in a permitted direct chat.',
            }),
      };
    const handoff = admitted.item;
    this.owned.set(handoff.id, handoff);
    return handoffReceipt(this.core, handoff);
  }

  /** Resolve once every hand-off has settled. For tests. */
  async idle(): Promise<void> {
    await this.queue.idle();
  }

  private signalTerminals(): void {
    if (this.stopped) return; // Existing private dispatch shutdown owns its lifetime; next boot consumes ready notices.
    try {
      this.flushTerminals();
    } catch (error) {
      logger.warn('[handoffs] terminal notice remains durable', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  /** Boot once after actual runtime/coordinator wiring. Queued retains original policy and deadline. */
  initializeDurable(notify: () => void): void {
    if (this.booted) throw new Error('Room handoffs already initialized');
    this.notifyTerminals = notify;
    this.booted = true;
    this.core.store.handoffOutbox.recoverQueued(Date.now());
    this.refill();
    this.signalTerminals();
  }
  /** Existing public SYSTEM notices and private source notices share the durable ready cursor. */
  flushTerminals(): void {
    if (this.stopped) return;
    flushOriginalRoomNotices(this.core, this.postOriginalNotice);
    this.notifyTerminals();
    this.core.store.handoffOutbox.pruneSettled(Date.now());
  }
  private refill(): void {
    if (!this.booted || this.stopped) return;
    for (const row of this.core.store.handoffOutbox.queuedRows()) {
      if (this.owned.has(row.id)) continue;
      if (Date.now() >= row.waitDeadlineAt) {
        this.core.store.handoffOutbox.declineQueued(row.id, WAIT_EXPIRED);
        continue;
      }
      const admitted = this.queue.admit(
        agentKey(row.roomId, row.authorId),
        row.waitDeadlineAt,
        () => {
          return restoreHandoff(row);
        }
      );
      if (admitted.accepted) this.owned.set(row.id, admitted.item);
    }
  }
  /** Durable read never turns settled-history eviction or restart into an unsafe resend instruction. */
  status(id: string, authorId: string): HandoffStatus {
    return durableHandoffStatus(
      this.core.store.handoffOutbox,
      this.outcomes,
      id,
      authorId,
      Date.now(),
      WAIT_EXPIRED
    );
  }

  private targetCurrent(handoff: RoomHandoff): boolean {
    const original = decodeHandoffEnvelope(handoff.envelopeJson);
    const room = this.core.store.getRoom(handoff.roomId);
    const member = this.core.store.getMember(handoff.roomId, handoff.authorId);
    const binding = this.core.store.sessionLedger.bindingForSession(handoff.ownedSeatSessionId);
    return (
      !handoff.cancelled &&
      room !== null &&
      !room.archived &&
      member?.joinedAt === original.seat.joinedAt &&
      binding?.roomId === handoff.roomId &&
      binding.authorId === handoff.authorId &&
      binding.sessionId === this.core.store.getRoomSession(handoff.roomId, handoff.authorId)
    );
  }
  private terminalText(handoff: RoomHandoff, reason: string | null): string {
    return (
      buildHandoffNotice(
        nameForAgents(this.core, handoff.authorId, { sentenceStart: true }) ?? 'An agent',
        handoff.authorId,
        roomLabel(this.core.store.getRoom(handoff.roomId), this.core.bridges),
        reason
      ).text ?? 'Room handoff ended.'
    );
  }
  /** Returned binder runs inside the actual append transaction, BEFORE any post observer. */
  bindPosted(handoff: RoomHandoff) {
    return (entryId: string, tx: DbTransaction, seq: number): void => {
      if (!handoff.dispatchId || !this.targetCurrent(handoff))
        throw new Error('Handoff no longer owns this post.');
      this.core.store.handoffOutbox.postedBinder(
        handoff.id,
        this.bootOwner,
        handoff.dispatchId,
        entryId,
        this.terminalText(handoff, null)
      )(tx, seq);
    };
  }
  /** Stop waiting/preparing hand-offs without cancelling already running model turns. */
  stop(): void {
    this.reports.stop();
    this.stopped = true;
    this.queue.stop();
    for (const handoff of this.owned.values()) {
      if (!handoff.started) this.cancelWaiting(handoff);
    }
  }

  /** Shutdown records status synchronously; it does not schedule new notices after storage closes. */
  private cancelWaiting(handoff: RoomHandoff): void {
    handoff.cancelled = true;
    handoff.waitAbort.abort();
    const row = this.core.store.handoffOutbox.readOwned(handoff.id, handoff.authorId);
    if (row?.state === 'preparing')
      this.core.store.handoffOutbox.declineOwned(
        handoff.id,
        this.bootOwner,
        'it stopped before its turn started.'
      );
    this.outcomes.settle(handoff.id, handoff.authorId, {
      status: 'declined',
      reason: 'it stopped before its turn started.',
    });
    this.owned.delete(handoff.id);
  }

  /** A queued draft expires independently of any running model turn. */
  private async decline(handoff: RoomHandoff, reason: string): Promise<void> {
    const row = this.core.store.handoffOutbox.readOwned(handoff.id, handoff.authorId);
    if (row?.state === 'queued')
      this.core.store.handoffOutbox.declineQueued(
        handoff.id,
        reason,
        this.terminalText(handoff, reason)
      );
    else if (row?.state === 'preparing' || row?.state === 'running')
      this.core.store.handoffOutbox.declineOwned(
        handoff.id,
        this.bootOwner,
        reason,
        this.terminalText(handoff, reason)
      );
    this.outcomes.settle(handoff.id, handoff.authorId, { status: 'declined', reason });
    this.owned.delete(handoff.id);
    if (!this.stopped) this.signalTerminals();
  }

  /** Where a draft came from: the room the drafting chat sits in, and who asked there. */
  private originOf(sessionId: string, authorId: string): HandoffOrigin {
    // The room keeps the session, or a live turn there runs on it: a first turn is named by the
    // runtime mid-turn, before the room's record of it moves.
    const binding = this.core.store.sessionLedger.bindingForSession(sessionId);
    const roomId =
      binding?.authorId === authorId
        ? binding.roomId
        : [...this.core.triggers.claimed.values()].find(
            (claim) => claim.authorId === authorId && claim.sessionId === sessionId
          )?.roomId;
    if (roomId === undefined) {
      return {
        sessionId,
        roomId: null,
        label: roomLabel(null, this.core.bridges),
        requester: null,
        memberJoinedAt: null,
      };
    }
    const room = this.core.store.getRoom(roomId);
    const turn = this.core.triggers.activeTurnHere(roomId, authorId);
    const asked = turn ? this.core.store.getEntryById(roomId, turn.entryId) : null;
    const requester =
      asked && asked.kind === 'post' && asked.authorId !== authorId
        ? nameForAgents(this.core, asked.authorId)
        : null;
    return {
      sessionId,
      roomId,
      label: roomLabel(room, this.core.bridges),
      requester,
      memberJoinedAt: this.core.store.getMember(roomId, authorId)?.joinedAt ?? null,
    };
  }

  /** Run one hand-off in its seat, waiting out a busy one, and send the answer back. */
  private async run(handoff: RoomHandoff): Promise<HandoffOutcome> {
    const key = agentKey(handoff.roomId, handoff.authorId);
    const deadline = handoff.waitDeadlineAt;
    let executionClaimed = false;
    let result: AsideResult | null = null;
    const trace: HandoffTrace = {
      handoffId: handoff.id,
      roomId: handoff.roomId,
      authorId: handoff.authorId,
      attempt: 0,
      oldSessionId: this.core.store.getRoomSession(handoff.roomId, handoff.authorId),
    };
    this.running.set(key, handoff);
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (handoff.cancelled)
          return { posted: false, reason: 'it stopped before its turn started.' };
        if (Date.now() >= deadline) {
          result = { outcome: 'refused', why: 'deadline', text: null };
          break;
        }
        const room = this.core.store.getRoom(handoff.roomId);
        if (room === null || room.archived) break;
        // A room nobody has posted in yet still takes the post: the turn is about its start.
        const [latest] = this.core.store.listEntries(handoff.roomId, { limit: 1 });
        const initialCarry = withRoomMarks(
          this.core,
          handoff.authorId,
          handoff.carried,
          room,
          latest
        );
        result = await this.core.triggers.askAside({
          room,
          handoffRecovery: true,
          untrustedText: true,
          handoffTrace: trace,
          admissionDeadlineAt: handoff.waitDeadlineAt,
          validateTarget: () => this.targetCurrent(handoff),
          beforeRun: () => {
            if (this.stopped || !this.targetCurrent(handoff) || !handoff.dispatchId) return false;
            // A runtime busy reply may retry under this live owner. Its saved running state
            // remains ambiguous across a crash; it must never become replayable queued work.
            if (!executionClaimed) {
              this.core.store.handoffOutbox.claimQueued(
                handoff.id,
                handoff.envelopeJson,
                this.bootOwner,
                Date.now(),
                () => {
                  if (!this.targetCurrent(handoff))
                    throw new Error('Handoff target changed before its claim.');
                }
              );
              executionClaimed = true;
            }
            this.core.store.handoffOutbox.markRunning(
              handoff.id,
              this.bootOwner,
              handoff.dispatchId,
              Date.now()
            );
            return true;
          },
          onSeatRecovered: (_old, fresh) => {
            // Called only once the DOR-4328 seat move, required launch and ledger agree; adopt that seat.
            // No second authority check may throw after the mover has installed an owned required launch.
            handoff.ownedSeatSessionId = fresh;
          },
          onStarted: () => {
            if (this.stopped || handoff.cancelled) return false;
            handoff.started = true;
            return true;
          },
          entry: latest ?? roomStartAnchor(room, handoff.authorId),
          authorId: handoff.authorId,
          prompt: seatPrompt(handoff, roomLabel(room, this.core.bridges)),
          carried: initialCarry,
          prepareCarry: () => {
            const currentRoom = this.core.store.getRoom(handoff.roomId);
            const [currentEntry] = this.core.store.listEntries(handoff.roomId, { limit: 1 });
            if (!currentRoom || currentRoom.archived)
              throw new Error('Handoff room is no longer available.');
            return joinHandoffCurrentCarry(
              decodeHandoffEnvelope(handoff.envelopeJson),
              withRoomMarks(this.core, handoff.authorId, initialCarry, currentRoom, currentEntry)
            );
          },
          onClaimed: (dispatchId) => {
            handoff.dispatchId = dispatchId;
            trace.dispatchId = dispatchId;
            this.outcomes.noteWaiting(handoff.id, handoff.authorId, 'running', deadline);
          },
        });
        handoff.started = false;
        if (this.stopped && result.outcome === 'busy') this.cancelWaiting(handoff);
        if (handoff.cancelled)
          return { posted: false, reason: 'it stopped before its turn started.' };
        const left = deadline - Date.now();
        if (result.failure?.refusal !== undefined) break;
        if (result.outcome === 'busy' && left <= 0) {
          result = { outcome: 'refused', why: 'deadline', text: null };
          break;
        }
        if (result.outcome !== 'busy') break;
        this.outcomes.noteWaiting(handoff.id, handoff.authorId, 'seat_busy', deadline);
        // Woken only when this agent's own turn ends: another agent's release says nothing about
        // this seat (and a refused try wakes nobody, see `releaseClaim`). Otherwise on a backoff.
        await this.core.triggers.nextRelease(
          Math.min(handoffRetryDelay(attempt), left),
          (claim) => claim.authorId === handoff.authorId,
          handoff.waitAbort.signal
        );
      }
    } catch (err) {
      // Server diagnostics stay in the local log, never in the shared decline reason.
      logger.warn('[rooms] handoff dispatch threw', {
        roomId: handoff.roomId,
        authorId: handoff.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      result = {
        outcome: 'failed',
        text: null,
        failure: { code: 'exception', detail: 'handoff dispatch threw' },
      };
    } finally {
      if (this.running.get(key) === handoff) this.running.delete(key);
      this.owned.delete(handoff.id);
    }
    const durable = this.core.store.handoffOutbox.readOwned(handoff.id, handoff.authorId);
    const room = this.core.store.getRoom(handoff.roomId);
    const outcome: HandoffOutcome =
      durable?.state === 'posted' && durable.postedEntryId !== null
        ? { posted: true, entryId: durable.postedEntryId }
        : { posted: false, reason: declineReason(room, result) };
    if (!outcome.posted) logHandoffFailure(trace, result);
    this.outcomes.settle(
      handoff.id,
      handoff.authorId,
      outcome.posted
        ? { status: 'posted', entryId: outcome.entryId }
        : { status: 'declined', reason: outcome.reason }
    );
    if (!outcome.posted) {
      // The status keeps the seat's reply; the notice that wakes the drafter never quotes it.
      const text = this.terminalText(handoff, noticeReason(room, result));
      if (durable?.state === 'queued')
        this.core.store.handoffOutbox.declineQueued(handoff.id, outcome.reason, text);
      else if (durable?.state !== 'posted')
        this.core.store.handoffOutbox.declineOwned(
          handoff.id,
          this.bootOwner,
          outcome.reason,
          text
        );
    }
    if (!this.stopped) this.signalTerminals();
    this.refill();
    return outcome;
  }
}
