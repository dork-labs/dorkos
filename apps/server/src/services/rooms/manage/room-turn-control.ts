/**
 * The control surface over turns a room is running right now: what is in
 * flight, what is waiting, and the three verbs a person uses to steer it.
 *
 * **A halt is a control action and is never inferred from anything anybody
 * typed** — no phase of this product pattern-matches a message for "stop",
 * because a person telling a looping agent to stop is exactly the message a
 * looping agent will treat as one more turn to answer. And only a PERSON may
 * use these: an agent stopping or reordering its room-mates is arbitration,
 * which this domain has declined twice (ADR 260726-170125).
 *
 * The reads are all delegated to the dispatcher's own claim map rather than
 * re-derived, because that map IS the answer — a second count computed from
 * the store would be a second truth that can disagree with the indicator
 * people are looking at.
 *
 * @module server/services/rooms/manage/room-turn-control
 */
import type { AuthorRegistry } from '../author-registry.js';
import type { ActiveClaimView, HeldView } from '../room-claims.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/** What a room is working on, and the three ways a person steers it. */
export class RoomTurnControl {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly triggers: RoomTriggerDispatcher;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility
  ) {
    this.store = core.store;
    this.authors = core.authors;
    this.triggers = core.triggers;
  }

  /**
   * Every room turn in flight right now, for the diagnostic read surface.
   *
   * Delegated rather than re-derived: the dispatcher's claim map IS the answer,
   * and a second count computed from the store would be a second truth that can
   * disagree with the indicator people are looking at.
   *
   * @returns One row per live claim.
   */
  listActiveClaims(): ActiveClaimView[] {
    return this.triggers.listClaims();
  }

  /**
   * Every agent workspace with a room turn running in it right now.
   *
   * {@link RoomService.listActiveClaims}'s in-process sibling: same claim map,
   * but it answers with filesystem paths, so it is for callers inside this
   * process only. Its consumer is the room-worktree reap, which must never
   * remove the working copy a live turn is standing in.
   *
   * @returns Each distinct workspace path holding a claim.
   */
  listBusyAgentPaths(): string[] {
    return this.triggers.busyAgentPaths();
  }

  /**
   * The agent members of one room, with the workspace path each is identified
   * by.
   *
   * **In-process only, exactly like {@link RoomService.listBusyAgentPaths}, and
   * for the same reason**: `/Users/dorian/…` is not something to hand every
   * member of a room. `RoomRoster.list` drops the natural key on purpose, so
   * this is the deliberate second door — narrow, unexported over any surface,
   * and used by one caller: the room-repo verbs, which need the path to work out
   * which standing worktree belongs to whom (`RoomWorktreeManager.slugFor`).
   * Anything derived from it that a caller sees is the SLUG, never the path.
   *
   * A ghost — an agent whose directory no longer holds one — is included, and
   * has to be: its worktree may still hold work nobody merged, and a status
   * report that quietly dropped it would be the reason somebody lost it.
   *
   * @param roomId - The room.
   * @returns One row per agent on the roster, in roster order.
   */
  listAgentMembers(roomId: string): { authorId: string; agentPath: string; displayName: string }[] {
    const members = this.store.listMembers(roomId);
    const authors = this.authors.getMany(members.map((member) => member.authorId));
    const agents: { authorId: string; agentPath: string; displayName: string }[] = [];
    for (const member of members) {
      const author = authors.get(member.authorId);
      if (!author || author.kind !== 'agent') continue;
      agents.push({
        authorId: author.id,
        agentPath: author.naturalKey,
        displayName: author.displayName,
      });
    }
    return agents;
  }

  /**
   * Every message waiting on an agent that is busy in another room.
   *
   * {@link RoomService.listActiveClaims}'s sibling, and the question it cannot
   * answer during an incident: a room showing no claim and no answer looks
   * exactly like a room whose message went nowhere. Delegated for the same
   * reason — the dispatcher's hold map IS the answer.
   *
   * @returns One row per live hold.
   */
  listHolds(): HeldView[] {
    return this.triggers.listHolds();
  }

  /**
   * Stop everything running in one room.
   *
   * RP8's halt verb (room-participation spec §10.4), and the only entry point
   * to it. **It is a control action and is never inferred from anything anybody
   * typed** — no phase of this product pattern-matches a message for "stop",
   * because a person telling a looping agent to stop is exactly the message a
   * looping agent will treat as one more turn to answer.
   *
   * Refuses like every other room verb: a caller who cannot see the room gets
   * the same `ROOM_NOT_FOUND` they get for a room that does not exist, and only
   * a person may halt — an agent stopping its room-mates mid-sentence is
   * arbitration, which this domain has declined twice (ADR 260726-170125).
   *
   * An archived room is NOT refused, deliberately, and it is the one place this
   * differs from `post`. Archiving stops a room gaining messages; a turn that
   * was already running when the room was archived is still running, and
   * refusing to stop it would leave the only way to stop it behind a door that
   * has just been shut.
   *
   * @param roomId - The room to stop.
   * @param viewerAuthorId - Who is stopping it.
   * @returns How many in-flight turns were interrupted; `0` when it was idle.
   */
  async haltRoom(roomId: string, viewerAuthorId: string): Promise<number> {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    this.visibility.requirePersonAuthor(viewerAuthorId, 'stop a room');
    return this.triggers.halt(room);
  }

  /**
   * Stop one agent in a room, leaving the others working.
   *
   * The same three refusals as {@link RoomService.haltRoom}, plus one it cannot
   * have: the target has to be an agent on this room's roster. Answering
   * `0` for a name that is not there would hide a client bug behind a success,
   * and nothing leaks by saying so — `requireVisibleRoom` has already
   * established that this caller can see the room and its roster.
   *
   * A person on the roster is refused by the same code, and the sentence is
   * literally true: there is no agent by that id here. A second code that no
   * client would treat differently is a second thing to keep true.
   *
   * Order is load-bearing and matches every other verb here: **room first, then
   * caller, then target.** A caller who cannot see the room gets
   * `ROOM_NOT_FOUND` whether or not the agent exists, so a room id is never a
   * way to enumerate a roster.
   *
   * Archived rooms are allowed, exactly as they are for the room-wide halt.
   *
   * @param roomId - The room.
   * @param authorId - The agent to stop.
   * @param viewerAuthorId - Who is stopping it.
   * @returns `1` when a turn was interrupted, `0` when the agent was not running
   *   one here. `0` is a success.
   */
  async haltAgent(roomId: string, authorId: string, viewerAuthorId: string): Promise<number> {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    this.visibility.requirePersonAuthor(viewerAuthorId, 'stop an agent');
    if (
      this.store.getMember(roomId, authorId) === null ||
      this.authors.getById(authorId)?.kind === 'human'
    ) {
      throw new RoomError('MEMBER_NOT_FOUND', 'No such agent in this room.');
    }
    return this.triggers.haltAgent(room, authorId, viewerAuthorId);
  }

  /**
   * Ask for this room's waiting message to be answered before the other rooms
   * waiting on the same agent.
   *
   * **It reorders and never preempts**, which is what keeps it out of the
   * arbitration this domain has declined twice (ADR 260726-170125): the blocking
   * turn is untouched, no second turn is started, and a promoted message still
   * waits for the agent to be free. What it orders is one agent's own unanswered
   * messages, which is what a person means by "answer me first".
   *
   * Gated exactly as {@link RoomService.haltRoom} is — a caller who cannot see
   * the room gets the same `ROOM_NOT_FOUND` a room that does not exist gets, and
   * only a person may ask, because an agent reordering its own queue would be
   * the agent deciding whose question matters.
   *
   * @param roomId - The room asking to be answered first.
   * @param authorId - The agent it is waiting on.
   * @param viewerAuthorId - Who is asking.
   * @returns `false` when there was nothing waiting — a stale button, not an
   *   error.
   */
  promoteHold(roomId: string, authorId: string, viewerAuthorId: string): boolean {
    this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    this.visibility.requirePersonAuthor(viewerAuthorId, 'ask to be answered first');
    return this.triggers.promoteHold(roomId, authorId);
  }

  /**
   * Ask one agent something the room never posted, on the room's own session
   * for it, and hand back what it said.
   *
   * The one caller is the welcome-back offer (DOR-1046): a person came back,
   * their agents have already posted what they did, and this is how one of them
   * is asked whether it has a next step worth a decision. It is deliberately
   * NARROW — it takes no viewer, refuses nobody by name, and posts nothing, so
   * it cannot become a second way to make an agent speak. Every bound a normal
   * trigger has still applies; see {@link RoomTriggerDispatcher.askAside}, which
   * also explains why the answer comes back rather than going straight in.
   *
   * **Never throws.** A missing room, an archived one, a deleted entry and a
   * failed turn are all the same answer: `null`, because the greeting this
   * belongs to must not fail the read-state write that revealed it.
   *
   * @param input.roomId - The room the offer belongs to.
   * @param input.authorId - The agent being asked.
   * @param input.aboutEntryId - The status line it just posted.
   * @param input.prompt - The question, as the model will see it.
   * @returns What it said, or `null` for silence of any kind.
   */
  async askAside(input: {
    roomId: string;
    authorId: string;
    aboutEntryId: string;
    prompt: string;
  }): Promise<string | null> {
    const room = this.store.getRoom(input.roomId);
    // An archived room takes no new posts, so an offer for it could never be
    // written down — spending a turn to find that out would be the speculative
    // cost this whole feature is gated on avoiding.
    if (room === null || room.archived) return null;
    const entry = this.store.getEntryById(input.roomId, input.aboutEntryId);
    if (entry === null) return null;
    return this.triggers.askAside({
      room,
      entry,
      authorId: input.authorId,
      prompt: input.prompt,
    });
  }
}
