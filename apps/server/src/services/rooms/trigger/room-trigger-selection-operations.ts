import type { Room, RoomEntry, SkippedTrigger } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import {
  selectTriggerTargets,
  pickLead,
  standDownFallbackSeat,
  whyNobody,
  type AddressingMember,
} from '../addressing.js';
import { toAuthorRef } from '../author-registry.js';
import { isLiveAuthor } from '../handles/author-handles.js';
import {
  evaluateCascade,
  type CascadeDecision,
  type CascadeRefusalReason,
} from '../cascade-guard.js';
import {
  agentPostWindow,
  conversationFor,
  engagementFor,
  type EngagementWindow,
} from '../engagement.js';
import { buildCascadeNotice } from '../notices/notice-copy.js';
import { readOriginalRoomTriggerFacetView, withGone } from '../room-trigger.js';
import type { TriggerCandidate } from '../room-trigger.js';

/**
 * Select this entry's targets, run each past the guard, and write a notice for
 * every refusal.
 *
 * Evaluation happens for ALL targets before any of them is collected, so two
 * agents addressed by the same message do not cancel each other out — they
 * were both addressed by a message neither of them wrote.
 *
 * **Everything decided here is decided about THIS MESSAGE**, which is why it
 * stays synchronous inside `RoomService.post` rather than moving into the
 * collect window with the turn. Who a message addressed, whether the exchange
 * it belongs to has gone around enough times, and whether a name it typed
 * reached nobody are all facts about the message; answering them half a second
 * later would let a room's roster change under a refusal, and would delay
 * every notice a person is owed.
 *
 * **It reports its refusals as well as its choices**, which is what lets the
 * 202 be honest (`PostToRoomResponse.skipped`). The set is exactly the one this
 * pass decides — a guard refusal, or an agent whose directory no longer holds
 * it — and it is assembled from the same two places that write the notices, so
 * what this pass decides and what it says cannot disagree.
 *
 * That is a claim about THIS PASS and nothing later. A candidate returned here
 * is judged again when its batch runs, and can be refused then; see
 * {@link RoomDispatchSummary} for what the accept-time answer does and does not
 * promise.
 */
export function selectCandidates(
  triggerOwner: object,
  room: Room,
  entry: RoomEntry,
  namedUnreachable: readonly string[]
): { candidates: TriggerCandidate[]; skipped: SkippedTrigger[] } {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const members = facet.deps.store.listMembers(room.id);
  const records = facet.deps.authors.getMany(members.map((m) => m.authorId));
  // ONCE PER ENTRY, not once per turn. The engaged window is per member, but
  // its thread scope and its clock are shared by everyone this entry could
  // trigger — and the answer has to be the same for addressing and for the
  // context the turn is handed, or an agent gets told it is engaged by the
  // very message that decided it was not.
  const window = facet.deps.engagedWindow();
  const now = new Date();
  const threadRootEntryId = entry.threadRootEntryId ?? null;
  const engaged = new Map<string, EngagementWindow>();
  const addressing: AddressingMember[] = [];
  // The channel's LEAD — the agent that answers a person's message nobody
  // else is answering (DOR-2823). Read from the room this dispatch already
  // holds, so it costs no query.
  const leadAuthorId = room.leadAuthorId ?? null;
  // Who holds this room's FALLBACK SEAT: the lead of a system room, which is
  // #team's default agent held on `always` (team-room-home spec D3.4), and
  // `null` everywhere else. Only there does the seat's stand-down apply: in
  // any other channel a person may set the lead to `always` themselves and
  // mean it, and the lead's own rule (`pickLead`, below) needs no `always`.
  const seatAuthorId = room.wellKnown ? leadAuthorId : null;
  // Resolved once and read three times, because every rule below asks the
  // same question about the same post: only a PERSON's message implicitly
  // addresses anybody. An author row that has vanished reads as `system`,
  // which is the conservative side of all of them.
  const authorKind = records.get(entry.authorId)?.kind ?? 'system';
  // **A person's post follows the conversation, not the clock** (DOR-2823).
  // One walk of the scope for the whole roster, because the answer — who
  // this person is talking to — is the same for every member. An agent's post
  // keeps the mention-anchored window below, at the old bound.
  const followsConversation = authorKind === 'human' && room.kind === 'channel';
  const conversation = followsConversation
    ? conversationFor(facet.deps, {
        roomId: room.id,
        threadRootEntryId,
        isAgentMember: (id) => records.get(id)?.kind === 'agent',
        joinsConversations: (id) => {
          const mode = members.find((member) => member.authorId === id)?.responseMode;
          return mode === 'engaged' || mode === 'always';
        },
        isPerson: (id) => records.get(id)?.kind === 'human',
        window,
        now,
      })
    : null;
  // The mention-anchored window, for every post the conversation rule does
  // not cover. An agent's post is weighed at the old bound. A person's post
  // outside a channel keeps the configured one deliberately: there it only
  // shapes what an engaged agent is told about its window, because a person's
  // message in a direct message is addressed to everyone in it anyway.
  const mentionWindow = authorKind === 'human' ? window : agentPostWindow(window);
  for (const member of members) {
    const record = records.get(member.authorId);
    if (!record) continue;
    // Only an agent that did not write this entry can be inside a window, so
    // no other membership pays for the query.
    //
    // The seat is weighed even though its `always` mode ignores the flag: it
    // READS the window to decide whether to stand down for a post that
    // addressed somebody else. For an agent's post that is one bounded query
    // for that one member; a person's post in a channel reads the
    // conversation above instead, once for the whole roster.
    const weighable = member.responseMode === 'engaged' || member.authorId === seatAuthorId;
    const candidate = record.kind === 'agent' && weighable && member.authorId !== entry.authorId;
    const open = !candidate
      ? null
      : followsConversation
        ? conversation?.partners.includes(member.authorId)
          ? conversation.window
          : null
        : engagementFor(facet.deps, {
            roomId: room.id,
            threadRootEntryId,
            authorId: member.authorId,
            window: mentionWindow,
            now,
          });
    // The CONTEXT map takes `engaged` members only, and deliberately: an
    // agent's `roomContext.addressing` promises a window is `null` for every
    // other mode (`room-context.ts`), because reporting one would describe a
    // bound that mode does not apply. The fallback seat's window decides one
    // filter below and is never told to the agent.
    if (open && member.responseMode === 'engaged') engaged.set(member.authorId, open);
    addressing.push({
      authorId: member.authorId,
      kind: record.kind,
      responseMode: member.responseMode,
      isEngaged: open !== null,
    });
  }

  // The second rule, a no-op in a room with no seat: a post that named another
  // agent is that agent's to answer, and a post an AGENT wrote is a
  // conversation already underway — the seat catches neither. See
  // `standDownFallbackSeat` for the two escapes.
  const matrix = selectTriggerTargets({
    roomKind: room.kind,
    authorKind,
    entry,
    members: addressing,
  });
  const answered = standDownFallbackSeat({
    entry,
    authorKind,
    seatAuthorId,
    members: addressing,
    selected: matrix,
    conversationPartners: conversation?.partners ?? [],
  });
  // **A person's post nobody else is answering goes to the channel's lead**
  // (DOR-2823), whatever the lead's mode. Only when the rules above picked
  // nobody, so a conversation with another agent is never interrupted by it,
  // and never for an agent's post: agents talking to each other stay quiet.
  // Never in a channel connected to an outside chat: its one agent answers
  // @mentions only there, and strangers' messages must not change that.
  const lead =
    answered.length === 0 && followsConversation && facet.deps.bridgedFraming(room.id) === null
      ? pickLead({ entry, leadAuthorId, members: addressing })
      : null;
  const selected = lead ? [lead] : answered;
  if (selected.length === 0) {
    // A person's post in a channel that reaches nobody is the failure
    // DOR-2823 is about, so every one is logged with why. Never a member's
    // name or a message body, only ids and the reason.
    if (followsConversation) {
      const reason = whyNobody({
        entry,
        members: addressing,
        namedUnreachable,
        partners: conversation?.partners ?? [],
      });
      logger.info('[rooms] nobody was picked to answer a person', {
        roomId: room.id,
        entryId: entry.id,
        reason,
      });
      // No entry is written for it: a stored line would bump unread counts
      // in channels where people talk among themselves. The app shows the
      // "no agent is in this channel" hint above the composer instead.
    }
    // **The commonest shape of the ghost case comes through here**, and it is
    // why this is not a bare `return`. A channel seeds agents at `engaged`, and
    // a ghost claims no names — so `@ana are you there?` addresses nobody,
    // selects nobody, and would leave the room silent in answer to the most
    // direct question in it. No selection ran, so nothing can overlap: the set
    // is exactly what the message named.
    //
    // A stand-down can empty the set too, and it writes NO notice — which is
    // deliberate, and the same call this file already makes for the depth
    // refusal against an agent's own un-provenanced post. A notice announces
    // that something you asked for did not happen; the seat standing down is
    // the opposite, an agent you did NOT address declining to spend a turn.
    // The shape that empties the set is a post naming only an agent somebody
    // silenced, and the room being quiet is precisely what silencing it asked
    // for. Announcing it would also spray: nothing damps a line that could
    // land on every message in a busy room.
    facet.reportGone(room, entry, new Set(namedUnreachable), namedUnreachable);
    // A stand-down or an unaddressed post skipped nobody: those members were
    // never asked, and listing them would turn "this message was not for you"
    // into a refusal. Only the names that reached nobody are reported.
    return { candidates: [], skipped: withGone([], new Set(namedUnreachable)) };
  }

  // **The whole of "limits off", for the guard half**, now asked of THIS
  // room. `turnLimitsEnabled` is read HERE rather than inside
  // `cascade-guard.ts`, which stays limit-agnostic and fully tested: a pure
  // function that sometimes decides not to decide is a worse thing to reason
  // about than a caller that decides not to ask. Unlimited means no
  // provenance query, no verdict, and no notice — nothing was refused, so
  // there is nothing to say. The stamped depth still advances, so an exchange
  // that ran unlimited is still readable as a chain afterwards, and turning
  // limits back on judges it normally.
  const limits = facet.cascadeLimitsFor(room.id);
  const provenance = limits
    ? {
        root: entry.cascadeRoot,
        depth: entry.cascadeDepth,
        turnsByAuthor: facet.deps.store.turnsByAuthorInCascade(room.id, entry.cascadeRoot),
      }
    : null;

  const allowed: TriggerCandidate[] = [];
  // The guard's refusals, in the order they were made. `gone` is folded in at
  // the end, from the same set the notices are written from.
  const refused: SkippedTrigger[] = [];
  // Collected rather than reported inline, so a member that is BOTH a selected
  // target and a name this message typed gets one notice, not two.
  const gone = new Set<string>(namedUnreachable);
  for (const { authorId, reason } of selected) {
    const record = records.get(authorId);
    const decision: CascadeDecision =
      limits && provenance
        ? evaluateCascade(authorId, provenance, limits)
        : { allowed: true, depth: entry.cascadeDepth + 1 };
    if (!decision.allowed) {
      // Only announce a limit something actually hit. A `depth` refusal
      // against an entry that is its OWN cascade root did not come from a
      // back-and-forth — it comes from the ceiling `deriveCascade` synthesizes
      // for an agent posting with no turn behind it. Announcing it said "Bo
      // stopped replying here. This back-and-forth hit its automatic-reply
      // limit" when Bo was never triggered, no exchange happened, and the
      // suggested remedy does nothing. Five ordinary posts by one agent
      // produced five such lines, one per room-mate, and the dedupe never
      // engaged because each post is its own root.
      //
      // THIS SILENCE IS DELIBERATE, and it survived a second look during
      // DOR-621 — which added notices to every other quiet path in this file.
      // It reads like a hole in "a refusal is visible" and it is not, for
      // three reasons worth having in front of you before you close it:
      //
      //   1. `deriveCascade` stamps such a post AT the ceiling
      //      (`cascade-guard.ts`), not at depth 0. So this refusal fires at
      //      EVERY `maxAgentDepth`, for every room-mate, on every post an
      //      agent makes outside a turn. Copy that offers to raise a limit is
      //      inert here: no limit was reached, and raising it changes nothing.
      //   2. The `(room, cascade, agent)` damping key CANNOT repeat here,
      //      because each such post is its own cascade root. Whatever notice
      //      you add is written once per post per room-mate, forever. Closing
      //      this needs a key that repeats — keyed on the room and the quiet
      //      agent, re-armed the way `noticedBudget` re-arms — not this one.
      //   3. A test pinned at `maxAgentDepth: 0` passes while the spraying
      //      case is broken, because 0 is the one value that makes the shape
      //      look sane. Any test here must use a realistic ceiling.
      //
      // The invariant is served differently: nothing was ever triggered, so
      // there is no agent that went quiet on you. `room-silence.test.ts` pins
      // BOTH sides of that narrowness — the silence here, and the two real
      // refusals that must still speak (a repeat stop, and a chain that
      // reaches the depth ceiling), so this cannot be widened into a spray or
      // narrowed into a general hush without something going red.
      //
      // On the two terms below: `fromRealChain` is the load-bearing one, and
      // the `repeat` term is a guard rather than a discriminator. Every
      // reachable repeat refusal ALSO has `fromRealChain` true, because a
      // cascade whose root is this entry contains only this entry (plus
      // system notices), so the target's count in it is zero. Kept because
      // that is a property of `deriveCascade` in another module, not of
      // anything here, and it costs one comparison to not depend on it.
      //
      // **An agent the room already knows is GONE is left to `reportGone`,
      // both here and on the wire.** It reads like a missing branch and it is
      // the opposite: this member was named by a message and its directory no
      // longer holds it, so `agent_gone` is about to be written — with the
      // remedy, which is to register it again. Adding "this back-and-forth hit
      // its automatic-reply limit" beside that is two lines about one member
      // for one message, and the second one is advice that does nothing. The
      // same reasoning decides the wire: `skipped` reports it once, as `gone`,
      // which is both the deeper fact (an agent that is not there cannot
      // answer whatever the guard thought) and the one the log agrees with.
      //
      // It is also what keeps `refused` and `gone` DISJOINT, which is the
      // invariant the two `continue`s below rest on: a guard-refused author
      // never reaches the liveness check, and a liveness-failed author was
      // never guard-refused.
      if (gone.has(authorId)) continue;
      facet.announceCascade(room, entry, authorId, record?.displayName, decision.reason);
      // Reported to the POSTER even in the one case the room stays quiet
      // about. The three reasons for that silence are all reasons not to write
      // a durable line at every room-mate; none of them is a reason to leave
      // the writer itself guessing about why its own message went unanswered,
      // and this answer is private, unduplicated and impossible to spray.
      refused.push({ authorId, reason: decision.reason });
      continue;
    }
    // `naturalKey` is the agentPath — the only handle the turn machinery needs
    // and the one thing that survives a mesh reconciler rebuild.
    if (!record || record.kind !== 'agent') continue;
    // A member whose directory no longer holds the agent it was added as
    // cannot take a turn, and until now nothing SAID so: the trigger went to
    // the runner, which failed somewhere inside on a path with no agent, and
    // the room reported "ran into a problem — open its session to see what
    // went wrong" about a session that does not exist. Refused here instead,
    // in its own words, because the remedy is to register the agent again
    // (ADR 260801-003051). The same test covers the subtler half: a DIFFERENT
    // agent registered in that directory is not this member either, and its
    // turns belong to its own author row.
    if (!isLiveAuthor(record, facet.deps.agents)) {
      gone.add(authorId);
      continue;
    }
    allowed.push({
      authorId,
      // `naturalKey` is the agentPath — the only handle the turn machinery
      // needs and the one thing that survives a mesh reconciler rebuild.
      agentPath: record.naturalKey,
      displayName: record.displayName,
      author: toAuthorRef(record),
      depth: decision.depth,
      engaged: engaged.get(authorId) ?? null,
      reason,
    });
  }

  facet.reportGone(room, entry, gone, namedUnreachable);
  // After the guard's own refusals, and from the SAME set the notices were
  // written from — so a member that was both a selected target and a name this
  // message typed is reported once, exactly as it is noticed once.
  return { candidates: allowed, skipped: withGone(refused, gone) };
}

/**
 * Say that the guard stopped an agent — unless announcing it would describe an
 * exchange that never happened.
 *
 * The whole of that exception is in the comment block at the call site in
 * {@link RoomTriggerDispatcher.selectCandidates}: a `depth` refusal against an
 * entry that is its OWN cascade root comes from the ceiling `deriveCascade`
 * synthesizes for an agent posting with no turn behind it, so nothing was
 * triggered, no limit was reached, and the notice would spray one line per
 * room-mate per post with no damping key that can ever repeat.
 *
 * @param room - The room the message landed in.
 * @param entry - The message the refusal is about.
 * @param authorId - The agent that was stopped.
 * @param displayName - Its name, or `undefined` when its row has vanished.
 * @param reason - Which rule refused it.
 */
export function announceCascade(
  triggerOwner: object,
  room: Room,
  entry: RoomEntry,
  authorId: string,
  displayName: string | undefined,
  reason: CascadeRefusalReason
): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  // On the two terms: `fromRealChain` is the load-bearing one, and the
  // `repeat` term is a guard rather than a discriminator. Every reachable
  // repeat refusal ALSO has `fromRealChain` true, because a cascade whose
  // root is this entry contains only this entry (plus system notices), so the
  // target's count in it is zero. Kept because that is a property of
  // `deriveCascade` in another module, not of anything here, and it costs one
  // comparison to not depend on it.
  const fromRealChain = entry.cascadeRoot !== entry.id;
  if (reason !== 'repeat' && !fromRealChain) return;
  facet.notices.announce(
    room,
    entry,
    authorId,
    buildCascadeNotice(displayName ?? 'An agent', authorId),
    reason === 'repeat' ? 'cascade_repeat' : 'cascade_depth',
    // Explicitly none. This target was refused before it could be given an id
    // — and `selectCandidates` runs synchronously inside `RoomService.post`,
    // which for an AGENT'S reply is inside that agent's own dispatch scope.
    // Left to the ambient id, a refusal about Bo would be filed under Ana's
    // dispatch.
    null
  );
}

/**
 * The cascade guard's two numbers for one room, or `null` when this room's
 * limits are off.
 *
 * One reading of the ladder per call, which is the point: the three loose
 * config readers this replaced were not independent — a person toggling
 * `turnLimitsEnabled` between two of them would have assembled half a
 * verdict. Resolved fresh every time, so a change binds the very next
 * message.
 *
 * @param roomId - The room being judged.
 */
export function cascadeLimitsFor(
  triggerOwner: object,
  roomId: string
): { maxAgentDepth: number; maxTurnsPerAgentPerCascade: number } | null {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const limits = facet.deps.limitsFor(roomId);
  if (!limits.turnLimitsEnabled) return null;
  return {
    maxAgentDepth: limits.maxAgentDepth,
    maxTurnsPerAgentPerCascade: limits.maxTurnsPerAgentPerCascade,
  };
}

/**
 * Everything one turn is told about what is left to spend — the room's hourly
 * headroom, the install's, and its remaining replies in this chain — with
 * `null` standing for every one of those that nothing is counting.
 *
 * `null` rather than a large number, because this is what an agent reads in
 * `room_context.budget` and decides how freely to answer against. With
 * nothing counting, any number here is invented: a big one implies a ceiling
 * that does not exist and a small one implies a squeeze that is not
 * happening. "No limit" is the only true thing to say.
 *
 * **The three are no longer `null` together, and that is the per-room
 * override showing through** (DOR-1429). A room with its own limits off on an
 * install that still counts reports `{ room: null, global: 4998,
 * repliesLeftInThisChain: null }` — the room's own two bounds are gone and
 * the install's wallet is not, which is exactly what `resolveRoomLimits`
 * decided. The two that ARE tied are the room's hourly headroom and its chain
 * headroom: both are `null` precisely when this room's `turnLimitsEnabled` is
 * false.
 *
 * **They are tied by both readings landing in one tick, not by a single
 * read.** This resolves the ladder twice — once here, once inside
 * {@link RoomTurnBudget.remaining} through `TurnBudgetLimits.perRoom` — and
 * nothing between them can move: the ladder's two rungs are a synchronous
 * `better-sqlite3` row read and a synchronous `conf` read, with no `await`
 * between the two calls, so no toggle can land in the gap. If either rung ever
 * becomes asynchronous, this is the pair that has to be resolved once and
 * threaded, because half a verdict here is a turn told it has no chain budget
 * while it still has a room budget.
 *
 * @param roomId - The room the turn is about to run in.
 * @param depth - The depth the turn being assembled carries, or `'ceiling'`
 *   for a turn that is nobody's reply and hands on no chain (an aside).
 */
export function headroomFor(
  triggerOwner: object,
  roomId: string,
  depth: number | 'ceiling'
): {
  budget: { room: number | null; global: number | null };
  repliesLeftInThisChain: number | null;
} {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const limits = facet.cascadeLimitsFor(roomId);
  return {
    budget: facet.deps.budget.remaining(roomId),
    repliesLeftInThisChain:
      limits === null ? null : depth === 'ceiling' ? 0 : Math.max(0, limits.maxAgentDepth - depth),
  };
}
