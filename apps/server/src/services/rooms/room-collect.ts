/**
 * Gathering a burst of messages into one turn, and holding the ones that land
 * while an agent is already working (room-participation spec §10.4, RP8).
 *
 * Before this existed, every message that addressed an agent was its own turn.
 * Three people typing at once bought three model calls that each answered a
 * third of the conversation, and a message that landed while the agent was
 * mid-turn bought nothing at all — it got an "it did not pick this up" notice
 * and waited for somebody else to say something before the agent ever saw it.
 *
 * Both are the same missing idea: **a turn answers a moment, not a message.**
 *
 * Four things about this module are load-bearing:
 *
 * 1. **The window opens once and does not slide.** The first message for a
 *    `(room, agent)` pair sets a deadline `collectDebounceMs` out; later ones
 *    join the same collection without pushing it back. A resetting timer is the
 *    textbook debounce and it is the wrong shape here — a room where somebody
 *    types every 400 ms would starve the answer for as long as the chatter
 *    lasted, which is the opposite of "collect, do not drop".
 *
 * 2. **A held collection is not a queue, and the difference is the claim.** An
 *    agent already mid-turn HERE keeps its collection parked until that turn's
 *    claim releases; nothing schedules it, nothing orders it against another
 *    agent, and no second turn is ever started beside the first. This domain has
 *    declined a scheduler twice (ADR 260726-170125) and still does: what is
 *    stored is what the agent has not read yet, which is a fact about the room
 *    rather than a plan about the future.
 *
 * 3. **A collection is keyed `(room, agent)` and NOT by thread**, so a burst can
 *    mix a thread reply with a channel post. The turn takes the scope of the
 *    message it answers — the newest one — and the rest ride whatever window
 *    that scope reads. In one direction that is free: a channel turn's window is
 *    the whole room, thread replies included. In the other it is the loss
 *    DOR-1207 already bounds and DECLARES rather than hides — a thread turn
 *    reads its thread, and the top-level messages it did not show ride
 *    `channelTail` with `channelTailOmitted` saying how many did not fit
 *    (`room-context.ts`). Gathering makes that case likelier, not new. A thread
 *    dimension on this key would remove it and was left out deliberately: it
 *    would split one person's half-second of typing into two turns, and the
 *    disclosure DOR-1207 built is exactly what makes the cheaper answer honest.
 *
 * 4. **A message survives losing its collection; a PENDING TURN does not.** The
 *    two halves of that are worth separating, because only the first is a
 *    guarantee.
 *
 *    The MESSAGE is safe. A collection is a marker of what the next turn is FOR
 *    — the messages themselves are committed room entries, and they stay behind
 *    the agent's read cursor until a turn is actually shown them, so the ambient
 *    window (spec §8.3) delivers them whenever the next turn runs. That is why
 *    dropping the oldest entry when a parked collection overflows costs nothing
 *    but the `arrivedDuringPrevTurn` mark on that one line, and why a halt can
 *    drop every collection outright.
 *
 *    The pending TURN is process memory, and a restart loses it. Nothing here is
 *    persisted: a server that goes down holding a parked collection comes back
 *    with an unread message and no turn owed for it, so it is answered when the
 *    next post triggers that agent rather than on its own. That is the same
 *    exposure the claim map has (`room-trigger.ts`) and it is recorded in
 *    `.claude/rules/room-conduct.md`'s known gaps rather than worked around
 *    here — durability for this would be the scheduler this domain has declined
 *    twice, and it should be argued as one.
 *
 *    The third way a collection ends is neither: a message the guard refuses
 *    when the batch runs is DISCARDED on purpose, and visibly — see
 *    {@link import('./room-trigger').RoomTriggerDispatcher.chooseTrigger}.
 *
 * @module server/services/rooms/room-collect
 */
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import type { EngagementWindow } from './engagement.js';
import { agentKey } from './room-claims.js';

/** One message waiting for a turn, with what the guard already decided about it. */
export interface CollectedTrigger {
  /** The committed entry. */
  entry: RoomEntry;
  /** The depth the cascade guard allowed this trigger at, decided when it arrived. */
  depth: number;
  /**
   * The agent's engaged window as it stood when this message landed, or `null`.
   * Carried rather than recomputed for the same reason `TriggerTarget` carries
   * it: the same clock, the same answer.
   */
  engaged: EngagementWindow | null;
  /**
   * True when it landed while this agent was already mid-turn here — the signal
   * `RoomContextEntry.arrivedDuringPrevTurn` renders.
   */
  arrivedDuringTurn: boolean;
}

/** Everything one agent has been asked, in one room, that no turn has answered. */
export interface RoomCollection {
  /** The room, carried so a flush needs no second lookup. */
  room: Room;
  authorId: string;
  agentPath: string;
  displayName: string;
  /** Oldest first. The LAST one is the message the turn answers; see the module docs. */
  entries: CollectedTrigger[];
  /**
   * When this window closes (`Date.now()` scale), or `null` while it is parked
   * behind a live claim and nothing is counting.
   */
  dueAt: number | null;
  /** True while this is waiting for an in-flight turn's claim to release. */
  parked: boolean;
}

/** The live `rooms.collect*` ceilings, read per burst so a change takes effect. */
export interface CollectWindow {
  /** How long a burst is gathered before it becomes a turn. */
  debounceMs: number;
  /** The most messages one gathered turn covers; reaching it closes it at once. */
  maxEntries: number;
}

/** One message arriving for one agent, as {@link RoomCollector.collect} takes it. */
export interface CollectInput {
  room: Room;
  authorId: string;
  agentPath: string;
  displayName: string;
  entry: RoomEntry;
  depth: number;
  engaged: EngagementWindow | null;
  /** True when this agent already holds a claim in this room. */
  duringTurn: boolean;
  /**
   * When this message arrived, as ONE clock reading shared by every agent it
   * reached (`Date.now()` scale).
   *
   * **Read once per message, never per agent, and that is a correctness
   * property.** A message addressing two agents opens two collections, and two
   * `Date.now()` calls a microsecond apart can land either side of a
   * millisecond boundary — which would give them deadlines 1 ms apart, put them
   * in two different sweeps, and let the first agent's turn RUN before the
   * second had claimed. The second would then be triggered by the first's reply
   * one cascade level deeper, instead of by the message that actually addressed
   * it. Measured as a one-in-many flake in `cascade-guard.test.ts`, where the
   * deepest entry in a two-agent exchange came out at 2 rather than 1.
   */
  arrivedAt: number;
}

/**
 * The per-`(room, agent)` collection buffers, and the one timer that closes
 * them.
 *
 * Deliberately owns nothing else. It does not know what a claim is, what a turn
 * costs, or how a refusal is announced — it holds messages, decides when a batch
 * is complete, and hands it back. `RoomTriggerDispatcher` supplies the `run`
 * callback and keeps every one of those decisions, which is what stops this
 * becoming a second place turns are started from.
 */
export class RoomCollector {
  private readonly collections = new Map<string, RoomCollection>();

  private readonly window: () => CollectWindow;

  private readonly run: (batch: RoomCollection[]) => void;

  /**
   * The one timer this collector runs, and the instant it was armed for.
   *
   * ONE, not one per collection, and that is a correctness property rather than
   * a saving. Every collection a single message opens shares a deadline, so a
   * sweep hands them back TOGETHER — which is what lets the dispatcher take
   * every claim before starting any turn, and therefore what lets an agent see
   * in `room_context.working` that the colleague the same message addressed is
   * already on it. A timer apiece would fire them in separate macrotasks, and
   * the first turn would be assembled against a room where nobody else had
   * started.
   */
  private sweeping: { timer: NodeJS.Timeout; at: number } | null = null;

  /**
   * Collections the CAP closed, waiting only for a macrotask to run on.
   *
   * They are out of {@link RoomCollector.collections} the instant the cap is
   * reached, and that is the point: `collect` is called synchronously from
   * `RoomService.post`, so a room where somebody pastes twenty lines in one tick
   * would otherwise keep adding to a collection that was already full. Out of
   * the map, the twenty-first message opens the next window — which is what "a
   * cap of twenty" has to mean for it to bound anything.
   */
  private closing: RoomCollection[] = [];

  /**
   * @param opts.window - The live collect ceilings, read per burst.
   * @param opts.run - Turn completed collections into turns, one turn apiece.
   *   Called with everything whose window closed at the same instant, so the
   *   caller can take every claim before starting any turn. Never re-entrant
   *   from {@link RoomCollector.collect}: even a zero-length window is a
   *   macrotask, so the writer that produced the trigger is off the stack first.
   */
  constructor(opts: { window: () => CollectWindow; run: (batch: RoomCollection[]) => void }) {
    this.window = opts.window;
    this.run = opts.run;
  }

  /**
   * Add one message to this agent's collection, opening one if there is none.
   *
   * @param input - The message, the agent, and whether a turn is already running
   *   for it here.
   * @returns `true` when this opened a NEW collection — the caller's cue to take
   *   whatever accounting a pending turn owes, since exactly one turn will come
   *   back for it.
   */
  collect(input: CollectInput): boolean {
    const key = agentKey(input.room.id, input.authorId);
    const trigger: CollectedTrigger = {
      entry: input.entry,
      depth: input.depth,
      engaged: input.engaged,
      arrivedDuringTurn: input.duringTurn,
    };
    const open = this.collections.get(key);
    if (open) {
      // The ROOM is refreshed as well as the entry list: a title, a topic or an
      // ambient cap may have changed since the window opened, and the turn
      // should be framed by the room as it is when it runs.
      open.room = input.room;
      open.entries.push(trigger);
      this.bound(key, open);
      return false;
    }
    const collection: RoomCollection = {
      room: input.room,
      authorId: input.authorId,
      agentPath: input.agentPath,
      displayName: input.displayName,
      entries: [trigger],
      dueAt: null,
      parked: input.duringTurn,
    };
    this.collections.set(key, collection);
    // A collection opened behind a live claim gets no deadline at all: it is
    // released by {@link RoomCollector.resume}, and a deadline would fire a turn
    // into an agent that is demonstrably busy.
    if (!collection.parked) this.arm(collection, undefined, input.arrivedAt);
    // The cap is checked on CREATION too, not only when a collection grows. At
    // `collectMaxEntries: 1` — the documented "answer every message on its own"
    // setting — the first message already fills the batch, and checking only on
    // growth meant the second message joined it and every turn covered two.
    this.bound(key, collection);
    return true;
  }

  /**
   * Put a collection back to wait for the claim that beat it to the agent.
   *
   * Its window has already closed by the time this is called, so there is
   * nothing to cancel — what it restores is the collection's place in the map,
   * which the sweep removed.
   *
   * **It MERGES rather than overwrites, and that is not defensive coding.** One
   * sweep can hand back two collections for the same agent — the cap closes a
   * batch and the next message in the same tick opens another, which is the
   * ordinary shape at `collectMaxEntries: 1`. The first of them claims and the
   * rest park, so a plain `set` would drop every one but the last: its messages
   * would never be answered, and the turn it was owed would never settle.
   *
   * Appending is order-safe because a sweep hands back collections in the order
   * they were opened, so anything parking onto an existing one is newer.
   *
   * @param collection - The collection whose flush found the agent busy here.
   * @returns `true` when it merged into a collection already waiting — the
   *   caller's cue that one pending turn fewer is now owed.
   */
  park(collection: RoomCollection): boolean {
    const key = agentKey(collection.room.id, collection.authorId);
    const waiting = this.collections.get(key);
    if (waiting && waiting !== collection) {
      waiting.room = collection.room;
      waiting.entries.push(...collection.entries);
      this.trim(waiting);
      return true;
    }
    collection.parked = true;
    collection.dueAt = null;
    this.collections.set(key, collection);
    return false;
  }

  /**
   * Run whatever this agent was asked while its turn was running.
   *
   * **This is the loop RP8 closes.** Without it a message that landed mid-turn
   * sat in the room log behind the agent's cursor until some LATER, unrelated
   * message triggered a turn — so a person who asked one more thing and then
   * stopped typing got no answer at all, and the room had already said the agent
   * was working. Called from the one place every claim is released, so there is
   * no terminal it can be forgotten at.
   *
   * @param roomId - The room whose claim just released.
   * @param authorId - The agent that just finished.
   */
  resume(roomId: string, authorId: string): void {
    const collection = this.collections.get(agentKey(roomId, authorId));
    if (!collection || !collection.parked) return;
    collection.parked = false;
    // No gathering wait — these messages have already waited out a whole turn.
    // Still a macrotask, though: this is reached from `releaseClaim`, inside a
    // `finally`, and taking the next claim from there would do it while the
    // previous turn's frame is still unwinding.
    this.arm(collection, 0);
  }

  /**
   * Forget every collection in one room, cancelling any window still open.
   *
   * A halt stops what a room is doing, and what a room is ABOUT to do is part of
   * that: leaving the buffers would answer, seconds later, the very messages the
   * person pressed Stop over. Nothing is lost that the room log does not still
   * hold — see the module docs.
   *
   * @param roomId - The room being stopped.
   * @returns The dropped collections, so the caller can settle whatever each one
   *   owed. One per collection, matching {@link RoomCollector.collect}'s `true`.
   */
  drop(roomId: string): RoomCollection[] {
    const dropped: RoomCollection[] = [];
    for (const [key, collection] of this.collections) {
      if (collection.room.id !== roomId) continue;
      this.collections.delete(key);
      dropped.push(collection);
    }
    // The cap-closed queue too: a collection between "full" and "running" is
    // still a turn this room has not taken, and a halt stops those as well.
    const stillClosing = this.closing.filter((collection) => collection.room.id !== roomId);
    for (const collection of this.closing) {
      if (collection.room.id === roomId) dropped.push(collection);
    }
    this.closing = stillClosing;
    // Re-armed rather than cleared: another room's window may still be open, and
    // this one going quiet is not a reason to stop counting for it.
    this.schedule();
    return dropped;
  }

  /**
   * Give a collection a deadline, if it does not already have one.
   *
   * @param collection - The collection to close.
   * @param delayMs - Override for the configured window; `0` is the resume path.
   * @param from - The instant to count from. The message's own arrival when one
   *   opened this collection, so every agent it addressed shares a deadline; see
   *   {@link CollectInput.arrivedAt}.
   */
  private arm(collection: RoomCollection, delayMs?: number, from?: number): void {
    // Already counting. The window opens ONCE per collection and does not slide
    // — see the module docs for why a resetting timer starves the answer.
    if (collection.dueAt !== null) return;
    collection.dueAt = (from ?? Date.now()) + Math.max(0, delayMs ?? this.window().debounceMs);
    this.schedule();
  }

  /** Arm the one timer for the earliest deadline any collection is holding. */
  private schedule(): void {
    // A collection the cap already closed is due now, not at some deadline it no
    // longer has.
    let next: number | null = this.closing.length > 0 ? Date.now() : null;
    for (const collection of this.collections.values()) {
      if (collection.dueAt === null) continue;
      if (next === null || collection.dueAt < next) next = collection.dueAt;
    }
    if (next === null) {
      if (this.sweeping !== null) clearTimeout(this.sweeping.timer);
      this.sweeping = null;
      return;
    }
    // Already armed for that instant or earlier. Re-arming would push the sweep
    // back, which is the sliding window the module docs rule out.
    if (this.sweeping !== null && this.sweeping.at <= next) return;
    if (this.sweeping !== null) clearTimeout(this.sweeping.timer);
    const at = next;
    const timer = setTimeout(() => this.sweep(at), Math.max(0, at - Date.now()));
    // A gathering window is not a reason for the process to stay alive: a CLI
    // that has finished should exit rather than hang for half a second on a
    // timer whose only job is to wait for a message nobody is going to send.
    // Optional-called like the presence heartbeat, which does not assume a Node
    // timer either.
    timer.unref?.();
    this.sweeping = { timer, at };
  }

  /**
   * Keep a collection inside `collectMaxEntries`, whichever way it is growing.
   *
   * Two shapes, because the cap means two different things either side of a
   * claim. A LIVE window that reaches the cap closes now instead of waiting out
   * the pause, so a room that never goes quiet still gets an answer and the next
   * message opens the next turn. A PARKED collection cannot close — its agent is
   * mid-turn — so it drops its oldest tracked message instead. That costs only
   * the `arrivedDuringPrevTurn` mark on that line: the message itself is in the
   * room log, behind the agent's cursor, and the ambient window delivers it.
   *
   * @param key - The `(room, agent)` key.
   * @param collection - The collection that just grew.
   */
  private bound(key: string, collection: RoomCollection): void {
    const max = Math.max(1, this.window().maxEntries);
    if (collection.entries.length < max) return;
    if (collection.parked) {
      this.trim(collection);
      return;
    }
    // Out of the map NOW, run one macrotask later. See {@link closing} for why
    // the two have to be separate steps.
    this.collections.delete(key);
    collection.dueAt = null;
    this.closing.push(collection);
    this.schedule();
  }

  /**
   * Drop the oldest tracked messages from a parked collection that has outgrown
   * the cap.
   *
   * A parked collection cannot close — its agent is mid-turn — so the cap can
   * only be honoured by forgetting. That costs the `arrivedDuringPrevTurn` mark
   * on the dropped lines and nothing else: the messages themselves are in the
   * room log, behind the agent's cursor, and the ambient window delivers them.
   *
   * @param collection - The parked collection to trim.
   */
  private trim(collection: RoomCollection): void {
    const max = Math.max(1, this.window().maxEntries);
    if (collection.entries.length <= max) return;
    collection.entries.splice(0, collection.entries.length - max);
  }

  /**
   * Hand back every collection whose window closed at or before `at`.
   *
   * @param at - The instant this sweep was armed for.
   */
  private sweep(at: number): void {
    this.sweeping = null;
    const due: RoomCollection[] = this.closing.splice(0);
    for (const [key, collection] of this.collections) {
      if (collection.dueAt === null || collection.dueAt > at) continue;
      this.collections.delete(key);
      collection.dueAt = null;
      due.push(collection);
    }
    // Re-armed BEFORE the callback, not after: `run` can park a collection
    // straight back, and re-arming afterwards would find a deadline that parking
    // deliberately cleared.
    this.schedule();
    if (due.length > 0) this.run(due);
  }
}
