/**
 * What a sweep of collected messages becomes: the response gate, ambient
 * routing, and the one entry a turn answers.
 *
 * Split out of `room-trigger.ts` without changing a line of logic. Each function
 * here is the body of a {@link RoomTriggerDispatcher} method of the same name,
 * which delegates to it with itself as `self`.
 *
 * @module server/services/rooms/room-trigger/batch-routing
 */
import type { AuthorKind, Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { logError, logger } from '../../../lib/logger.js';
import {
  routeAmbient,
  type RoutedEntry,
  type RoutingVerdict,
} from '../response-gate/routing-rules.js';
import { logRefusal } from '../../observability/refusals.js';
import { type TriggerTarget } from '../room-claims.js';
import { evaluateCascade, type CascadeDecision } from '../cascade-guard.js';
import { addresseesOf } from '../mentions.js';
import { type CollectedTrigger, type RoomCollection } from '../room-collect.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

/**
 * Run every collection whose window closed together: claim them all, then
 * start their turns.
 *
 * **Two passes, and the reason is the same one the two-pass bind has.**
 * `room_context.working` is read off the live claim map, so a turn assembled
 * before its colleague had claimed would tell an agent the room was idle when
 * a message it can see had just addressed somebody else too. Claiming
 * everything first makes that structural rather than a matter of which timer
 * fired first.
 *
 * @param batch - Every collection the collector just closed.
 */
export function runCollected(self: RoomTriggerDispatcher, batch: RoomCollection[]): void {
  const started: Array<{ room: Room; entry: RoomEntry; target: TriggerTarget }> = [];
  for (const collection of self.gateBatch(batch)) {
    const claimed = self.claimCollected(collection);
    if (claimed) started.push(claimed);
  }
  for (const { room, entry, target } of started) {
    void self.runOne(room, entry, target).finally(() => self.settleOne());
  }
}

/**
 * Drop the bursts an overhearing agent can be excused from, before anything
 * costs money (spec `engaged-response-gate` §3).
 *
 * **The gate is the last thing before the claim tail and the first thing that
 * could cost anything** — which in this release is nothing at all, because
 * tier 1 is a pure function with no clock, no store read of its own and no
 * model (`response-gate/routing-rules.ts`). Placing it here rather than inside
 * {@link RoomTriggerDispatcher.claimCollected} is what makes every property
 * below fall out for free rather than needing to be undone:
 *
 * | Not done | Because |
 * | -------- | ------- |
 * | Charged the budget | `budget.tryReserve` is downstream. Nothing is spent, so nothing needs refunding — which matters, since `tryReserve` has no counterpart and this file explicitly declines to invent one. |
 * | Counted against a limit | Nothing is reserved, no reply is posted, and no dispatch id is minted — so `room_turn_spend` gains no row, `turnsByAuthorInCascade` is unmoved, and the turn-scoped repeat counter (DOR-1434) counts nothing. |
 * | Moved the cursor | `setReadCursor` is downstream. The message stays behind this agent's cursor and reaches it as ambient background on whatever turn does run. |
 * | Taken a claim | `holdClaim` is downstream, so no working indicator appears and vanishes with nothing to show for it. |
 * | Said anything | No entry, no notice. Nobody asked, so there is no obligation to discharge (room-participation spec §10.2.2). |
 *
 * **Only a burst where EVERY message says `'window'` is eligible**, and that
 * one line is invariant I-G3. One `mention` or `dm` anywhere in a gathered
 * burst makes the whole burst addressed and it passes through untouched: an
 * addressed message is going to run a turn regardless, and the overheard ones
 * riding with it are context that turn is owed. Conservative in the only
 * direction that is safe to be wrong in.
 *
 * The four skips before the rules are the cheap deterministic ones, and none
 * of them is a verdict:
 *
 * - **Gate off** — this install said no.
 * - **Not ambient** — see above.
 * - **Busy** — {@link RoomTriggerDispatcher.claimCollected} is about to PARK
 *   this burst, and parking is not a decision. Routing it to silence now would
 *   spend a verdict on a question that gets asked again when the claim
 *   releases, against a room that has moved on.
 * - **Gone** — an archived room, or an agent no longer on the roster. The
 *   claim tail settles those as `left`, in its own words.
 *
 * Every one of them is re-checked downstream. This is a pre-filter, never a
 * replacement: `claimCollected` stays correct when called with a batch that
 * was never gated, which is exactly what `responseGate: 'off'` produces.
 *
 * **The busy and gone branches are DEFENSIVE, and no test reaches them.** Say
 * that plainly rather than leaving the next reader to infer coverage from the
 * tests that surround them, because both are shadowed by machinery upstream:
 *
 * - A collection opened behind a live claim is parked at the `collectOne`
 *   seam and given no deadline at all, so it is never swept and never arrives
 *   here. Its one REACHABLE shape is a race — a window that opened while the
 *   agent was free, and something claiming that agent (an aside turn, or a
 *   burst in another room sharing its checkout) between the arming and the
 *   sweep firing. That is the same race `claimCollected` re-asks for, and its
 *   comment there says so.
 * - A member that has left the room is never SELECTED, so no collection
 *   exists to judge; and archiving through the service calls `abandonHolds`,
 *   which drops every pending collection first.
 *
 * They stay because the cost is two comparisons and the failure they prevent
 * is a refusal line about a conduct decision nobody made — which would be
 * indistinguishable, in the ledger §14 tunes against, from a real mute. But
 * they are not load-bearing, and deleting them would leave every test green.
 *
 * **Judging is guarded and accounting is not**, deliberately. The `try` below
 * covers exactly the part that can have a bug in it — the rules, and the two
 * store reads that feed them — and a throw there falls open to a turn. It does
 * NOT cover `logRefusal` and `settleCollection`, because those run only after
 * a verdict is in, and a wrapper around them would have to decide whether a
 * half-finished accounting had already settled the collection. Every other
 * refusal site in this file leaves the same pair unguarded, for the same
 * reason: a logger that throws is a broken process, not a room outcome.
 *
 * @param batch - Everything the collector just closed.
 * @returns The collections that still deserve a turn, in the order given.
 */
export function gateBatch(self: RoomTriggerDispatcher, batch: RoomCollection[]): RoomCollection[] {
  if (self.deps.responseGate() === 'off') return batch;
  const survivors: RoomCollection[] = [];
  // One roster read per ROOM per sweep, not per collection: a burst that
  // reaches three agents in one channel asks the same question three times.
  const agentsIn = new Map<string, ReadonlySet<string>>();
  for (const collection of batch) {
    let verdict: NonNullable<RoutingVerdict> | null = null;
    try {
      verdict = self.routeCollection(collection, agentsIn);
    } catch (err) {
      // **Fail OPEN, per collection** (spec `engaged-response-gate` §9, and the
      // whole of invariant I-G6). Three things are true here and each one on
      // its own would decide it:
      //
      // 1. The fallback of a cost optimisation is the status quo it optimises.
      //    Running the turn is what shipped before this gate existed.
      // 2. **A gate outage must never be indistinguishable from good
      //    judgement.** Failing closed would take every agent in every room
      //    quiet, and the room would look exactly like a room full of tactful
      //    agents. That is the worst failure this domain can produce.
      // 3. There is no net under this. `RoomCollector.sweep` calls us from a
      //    `setTimeout` with nothing awaiting it, so an escaping throw reaches
      //    `process.on('uncaughtException')` — and on the way out it strands
      //    the hold this collection is between: `sweep` has already removed it
      //    from its map and `settleCollection` has not run, so `triggersIdle`
      //    never settles and the room wedges.
      //
      // PER COLLECTION, and that is the half a single wrapper around the loop
      // would get wrong: one bad burst must not drop the others in the same
      // sweep, and some of those others are ADDRESSED.
      //
      // Deliberately not a `logRefusal`: nothing was refused, the turn ran.
      // Counting this as a mute would corrupt the one signal §14 says to tune
      // against.
      logger.warn('[rooms] the response gate could not judge a message, so the turn ran', {
        roomId: collection.room.id,
        authorId: collection.authorId,
        entryId: collection.entries.at(-1)?.entry.id,
        ...logError(err),
      });
    }
    if (verdict === null) {
      survivors.push(collection);
      continue;
    }
    logRefusal('[rooms] an agent stayed out of a conversation it was not part of', {
      reason: 'not_addressed_to_me',
      visibility: 'chosen',
      roomId: collection.room.id,
      authorId: collection.authorId,
      entryId: collection.entries.at(-1)?.entry.id,
      // Explicitly none, and never the ambient one. No target has been given a
      // dispatch id — one is minted in `claimCollected`, downstream of here —
      // and this sweep may be running inside the scope of whichever agent's
      // reply produced the message being excused. Left ambient, a line about
      // Bo staying quiet would be filed under Ana's dispatch.
      dispatchId: null,
      detail: { tier: 1, rule: verdict.rule, entries: collection.entries.length },
    });
    self.settleCollection(collection, 'refused');
  }
  return survivors;
}

/**
 * Tier 1's verdict on one collection, or `null` to let it through.
 *
 * Split out from {@link RoomTriggerDispatcher.gateBatch} so the loop reads as
 * "decide, then account for the decision" — the accounting is three calls that
 * must all happen together, and burying them under four early returns is how
 * one of them gets missed.
 *
 * @param collection - The burst being weighed.
 * @param agentsIn - Per-room agent rosters memoised for this sweep.
 */
export function routeCollection(
  self: RoomTriggerDispatcher,
  collection: RoomCollection,
  agentsIn: Map<string, ReadonlySet<string>>
): NonNullable<RoutingVerdict> | null {
  const { room, authorId, agentPath } = collection;
  if (!collection.entries.every((held) => held.reason === 'window')) return null;
  if (self.busyWith(room.id, authorId, agentPath) !== null) return null;
  if (room.archived || self.deps.store.getMember(room.id, authorId) === null) return null;

  let agentMembers = agentsIn.get(room.id);
  if (!agentMembers) {
    const members = self.deps.store.listMembers(room.id);
    const records = self.deps.authors.getMany(members.map((member) => member.authorId));
    agentMembers = new Set(
      members
        .map((member) => member.authorId)
        .filter((memberId) => records.get(memberId)?.kind === 'agent')
    );
    agentsIn.set(room.id, agentMembers);
  }

  // ONE registry read for the whole burst. Every message's author, not the
  // roster's: a burst can carry a post by somebody who has since left, and a
  // kind that resolved to `system` because the row was not asked for would
  // read as "not an agent" and quietly stop two of the three rules firing.
  const kinds = self.deps.authors.getMany(collection.entries.map((held) => held.entry.authorId));
  return routeAmbient({
    agentAuthorId: authorId,
    agentMembers,
    entries: collection.entries.map((held) =>
      self.routedEntry(room.id, authorId, held.entry, kinds.get(held.entry.authorId)?.kind)
    ),
  });
}

/**
 * One collected message in the flat shape the routing rules take.
 *
 * The `answersThisAgent` lookup is the only store read here, it is one indexed
 * primary-key hit, and it is skipped entirely for the common case of a message
 * that answers nothing. An entry that cannot be found reads as `false`, which
 * is the conservative side: it can only stop a rule firing.
 *
 * @param roomId - The room.
 * @param agentAuthorId - The agent being judged.
 * @param entry - The committed message.
 * @param authorKind - Its author's kind, already resolved by the caller;
 *   `undefined` for a row that has vanished, which reads as `system` — the
 *   conservative side, since only an `agent` author can reach R2 or R3.
 */
export function routedEntry(
  self: RoomTriggerDispatcher,
  roomId: string,
  agentAuthorId: string,
  entry: RoomEntry,
  authorKind: AuthorKind | undefined
): RoutedEntry {
  const answersEntryId = entry.body.answersEntryId ?? null;
  const answered =
    answersEntryId === null ? null : self.deps.store.getEntryById(roomId, answersEntryId);
  return {
    entryId: entry.id,
    authorId: entry.authorId,
    authorKind: authorKind ?? 'system',
    // Who the message ASKS, not everyone it names: a cc delegates nothing and
    // obliges nobody (DOR-3401).
    mentions: addresseesOf(entry),
    answersEntryId,
    answersThisAgent: answered !== null && answered.authorId === agentAuthorId,
    answeredEntryMentionsThisAgent:
      answered !== null && addresseesOf(answered).includes(agentAuthorId),
  };
}

/**
 * Pick the newest message in a batch that the guard still allows, announcing
 * every newer one it refuses on the way past.
 *
 * **The guard is asked PER MESSAGE, and asking it once for the batch was a
 * real defect.** Its repeat rule counts a durable query, so a message collected
 * while a turn was in flight could not be judged against that turn's own post;
 * re-asking when the batch runs is what still terminates a two-agent
 * ping-pong. But a batch is not one message, and a verdict taken from the
 * newest entry alone is a verdict about the wrong thing: a person's direct
 * question, parked while the agent worked, was DISCARDED because an agent's
 * reply happened to join the batch behind it and the guard vetoed on that.
 * The person's question — a fresh cascade root at depth 0, which every rule
 * here allows — never ran, and nothing said so.
 *
 * So each message carries its own verdict, newest first, and the first one
 * that survives is what the turn answers. Three consequences are load-bearing:
 *
 * - **An agent-authored message can never veto a human-authored one.** That is
 *   the whole point of `deriveCascade`'s human carve-out: a person's message
 *   mints its own root at depth 0, so it is judged on its own terms and keeps
 *   them. The bug above was exactly this carve-out being lost by aggregation.
 * - **A refused message is left UNREAD.** The cursor advances only to the
 *   trigger, so anything above it is still in the next turn's ambient window
 *   rather than silently consumed by a turn that never saw it.
 * - **The refusal is visible**, damped per `(room, cascade, agent)` like every
 *   other guard refusal — including the one deliberate silence
 *   {@link RoomTriggerDispatcher.announceCascade} keeps, so a batch cannot
 *   become a way to spray the line §5.1.1 removed.
 *
 * @param collection - The batch being judged.
 * @returns The chosen message, its verdict and its index, or `null` when every
 *   message was refused — in which case the notices are already written.
 */
export function chooseTrigger(
  self: RoomTriggerDispatcher,
  collection: RoomCollection
): { held: CollectedTrigger; decision: CascadeDecision; index: number } | null {
  const { room, authorId, displayName } = collection;
  // Limits off in THIS room: nothing to re-ask. The newest message is the
  // trigger, and no notice is written because nothing was refused (see
  // {@link RoomTriggerDispatcher.selectCandidates} for the whole of it).
  const limits = self.cascadeLimitsFor(room.id);
  if (!limits) {
    const held = collection.entries.at(-1);
    if (!held) return null;
    return {
      held,
      decision: { allowed: true, depth: held.entry.cascadeDepth + 1 },
      index: collection.entries.length - 1,
    };
  }
  // One read per distinct cascade, not per message. A batch is usually one or
  // two exchanges, so this is a couple of indexed queries however long it is.
  const inCascade = new Map<string, ReadonlyMap<string, number>>();
  const turnsByAuthor = (root: string): ReadonlyMap<string, number> => {
    const known = inCascade.get(root);
    if (known) return known;
    const found = self.deps.store.turnsByAuthorInCascade(room.id, root);
    inCascade.set(root, found);
    return found;
  };
  for (let index = collection.entries.length - 1; index >= 0; index -= 1) {
    const held = collection.entries[index];
    const decision = evaluateCascade(
      authorId,
      {
        root: held.entry.cascadeRoot,
        depth: held.entry.cascadeDepth,
        turnsByAuthor: turnsByAuthor(held.entry.cascadeRoot),
      },
      limits
    );
    if (decision.allowed) return { held, decision, index };
    // Nothing here can double-announce: a message only reaches a collection
    // after the guard ALLOWED it, so this is the first refusal it can earn.
    self.announceCascade(room, held.entry, authorId, displayName, decision.reason);
  }
  return null;
}
