/**
 * Tier 1 of the engaged response gate: the messages an overhearing agent can be
 * excused from without asking anybody (spec `engaged-response-gate` §4).
 *
 * `engaged` is what every channel membership is seeded with
 * (`CHANNEL_RESPONSE_MODE`), and an engaged agent nobody named runs a **full
 * model turn** on every post inside its window, staying quiet by producing no
 * text. `meta/agent-etiquette.md` E7 says the opposite must be true — *"if an
 * agent is charged for listening, restraint becomes something the product
 * punishes"* — and DOR-1434 removed most of the accidental brake by raising the
 * turn ceilings roughly tenfold.
 *
 * This module is the free half of the fix. **No clock, no store, no model, no
 * network.** It answers one question about one collected burst and can only ever
 * answer it one way: `no`, or nothing. A `null` verdict is not a `yes` — it is
 * the absence of an opinion, and the turn runs exactly as it does today.
 *
 * ## The three rules are one idea
 *
 * All three are `meta/agent-etiquette.md` **E2** — *"do not answer a question
 * addressed to someone else"* — written as code rather than left to a prompt.
 * The codebase already makes exactly this call for exactly one member:
 * `standDownFallbackSeat` refuses the fallback seat a post that named another
 * agent, on the grounds that *"a post that named another agent is that agent's
 * to answer"*. These rules are that sentence applied to the population it was
 * always true of.
 *
 * ## What this module deliberately does not do
 *
 * - **It never reads message text.** Every input is resolved at write time by
 *   machinery no message body reaches: `mentions` (resolved once with spans in
 *   `mentions.ts`), `answersEntryId` (stamped by the room on every agent post),
 *   and author kinds. So tier 1 has no prompt-injection surface at all, which is
 *   not true of the classifier tier that follows it.
 * - **It is never a bound.** It receives the set of turns the deterministic
 *   bounds already permitted — cascade depth, cascade ancestry, both busy
 *   ceilings, both turn budgets — and removes some. It cannot add a turn, extend
 *   a window, raise a ceiling, or reach a target the addressing matrix did not
 *   select. That is the whole of why `.claude/rules/room-conduct.md`'s "never
 *   answer *do I run a turn* with a model call" is untouched here: there is no
 *   model, and the answer can only narrow.
 * - **It never touches an addressed trigger.** The caller
 *   (`RoomTriggerDispatcher.gateBatch`) will not call this for a burst carrying
 *   a `mention` or a `dm` selection, and the rules below would decline those
 *   anyway — every one of them requires the entry NOT to name this agent.
 *   Two independent things must break before a named agent can be silenced.
 *
 * @module server/services/rooms/response-gate/routing-rules
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { AuthorKind } from '@dorkos/shared/room-schemas';

/**
 * How much of the gate is switched on — `rooms.responseGate`.
 *
 * Aliased off the config schema rather than restated, so the two cannot drift
 * and the enum gains its next value (the classifier tier, DOR-1203 v1.1) in one
 * place. `'off'` is bit-for-bit the behaviour that shipped before the gate.
 */
export type ResponseGateMode = UserConfig['rooms']['responseGate'];

/**
 * Which rule sent a burst to silence.
 *
 * A closed union, and it rides the refusal ledger's `detail.rule` — so tuning
 * this gate is `jq 'select(.reason=="not_addressed_to_me") | .rule'` rather than
 * a reading exercise. Adding one is a deliberate act, like adding a
 * {@link import('../../observability/refusals.js').RefusalReason}.
 */
export type RoutingRule =
  /** The message named another agent in this room, and not this one. */
  | 'named_other_agent'
  /** An agent answering somebody else's question, in an exchange this agent is not in. */
  | 'colleagues_answer'
  /** An agent acknowledging something this agent said, without asking it anything. */
  | 'own_cascade_echo';

/**
 * What tier 1 concluded.
 *
 * `null` is **"no opinion"**, not "yes": the routing rules are a filter with one
 * output, and everything they do not recognise passes through untouched. Typing
 * it as a nullable rather than as a three-valued verdict is deliberate — a
 * `{ verdict: 'yes' }` this module could return would be a claim it has no way
 * to make.
 */
export type RoutingVerdict = { verdict: 'no'; rule: RoutingRule } | null;

/**
 * One collected message, with everything the rules need already resolved.
 *
 * Flat and pre-resolved rather than a `RoomEntry` plus a store handle, because
 * that is what keeps this module pure and its tests free of a database. The
 * caller does the two lookups (author kinds, and the author of the entry each
 * post answers) once per burst.
 */
export interface RoutedEntry {
  /** For the caller's logs; the rules never branch on it. */
  entryId: string;
  authorId: string;
  authorKind: AuthorKind;
  /** Author ids, resolved at write time. */
  mentions: readonly string[];
  /** The entry this post answers, or `null` — see `RoomEntryBody.answersEntryId`. */
  answersEntryId: string | null;
  /**
   * Whether the entry this post answers was written by the agent being judged.
   *
   * A boolean rather than an author id, for the same reason
   * {@link import('../addressing.js').AddressingMember.isEngaged} is a boolean
   * rather than a query: resolving it needs a store read, and this module has no
   * store. `false` when nothing is answered, and `false` when the answered entry
   * has been trimmed or cannot be found — which is the conservative side, since
   * it can only stop {@link RoutingRule.own_cascade_echo} firing.
   */
  answersThisAgent: boolean;
  /**
   * Whether the entry this post answers NAMED the agent being judged.
   *
   * **An obligation survives one hop, and this is the field that carries it.**
   * `@ana @nova what do you think?` names both; Ana answers first; and without
   * this, Nova — who was asked, by name, in the message being answered — is
   * excused by {@link RoutingRule.colleagues_answer} on the grounds that the
   * reply was Ana's. The question was Nova's too. Weighed against silently
   * dropping a direct ask, one extra turn is the cheap mistake.
   *
   * One hop, not transitively: only the immediately-answered entry is read. A
   * mention three replies back has been superseded by the conversation, and
   * chasing the chain would be a store walk on the ambient path.
   *
   * `false` when nothing is answered, and `false` when the answered entry cannot
   * be found — which is the side that can only stop a rule firing.
   */
  answeredEntryMentionsThisAgent: boolean;
}

/** What {@link routeAmbient} is asked. */
export interface RoutingInput {
  /** The agent being judged. */
  agentAuthorId: string;
  /**
   * Every AGENT member of this room, this one included.
   *
   * Needed by {@link RoutingRule.named_other_agent}, which fires on a named
   * *agent* and never on a named *person*: `@kai can you look at this?` is a
   * question put to a colleague in the room, and an agent that was already in
   * the conversation has no reason to step out of it.
   */
  agentMembers: ReadonlySet<string>;
  /** The burst, oldest first — every message this turn would be answering. */
  entries: readonly RoutedEntry[];
}

/**
 * Whether this burst can be routed to silence for free.
 *
 * **Every message must be excusable, and they need not be excusable for the same
 * reason.** A turn answers a moment rather than a message (RP8), so one
 * unrecognised post in a burst of four means the whole burst passes through —
 * the turn was always going to see all of it. Conversely a burst where one post
 * named a colleague and the next was that colleague's reply is silence twice
 * over, and reporting it under one rule is enough for tuning.
 *
 * The reported rule is the one that excused the **newest** message, because that
 * is the message the turn would have been answering.
 *
 * An empty burst yields `null`. Nothing reachable produces one — a collection
 * exists because a message opened it — but "no messages" is not evidence that
 * there was nothing to say, and returning `no` for it would make an unreachable
 * state into a silent one.
 *
 * @param input - The agent, its room-mates, and the burst.
 * @returns A `no` with the rule that reached it, or `null` for no opinion.
 */
export function routeAmbient(input: RoutingInput): RoutingVerdict {
  if (input.entries.length === 0) return null;
  let newest: RoutingRule | null = null;
  for (const entry of input.entries) {
    const rule = excuse(input, entry);
    if (rule === null) return null;
    newest = rule;
  }
  return newest === null ? null : { verdict: 'no', rule: newest };
}

/**
 * The rule that excuses one message, or `null` when none does.
 *
 * Ordered cheapest-and-broadest first; the order only decides which rule gets
 * the credit when two would fire, and every one of them is a `no` either way.
 *
 * @param input - The agent and its room-mates.
 * @param entry - The message being weighed.
 */
function excuse(input: RoutingInput, entry: RoutedEntry): RoutingRule | null {
  // Belt and braces with the caller's scope check. A message that named this
  // agent is addressed, and nothing below may excuse it — the caller already
  // refuses to gate such a burst, and this makes the property local to the file
  // that has to hold it.
  if (entry.mentions.includes(input.agentAuthorId)) return null;

  // R1. `@nova ship the release` triggers Nova AND every other engaged agent in
  // the channel today, each of which spends a turn deciding to stay out of it.
  // The mention has to be of an AGENT MEMBER: a name that resolves to a person,
  // or to somebody who is not in this room, delegates nothing.
  if (
    entry.mentions.some(
      (authorId) => authorId !== input.agentAuthorId && input.agentMembers.has(authorId)
    )
  ) {
    return 'named_other_agent';
  }

  // Everything below is about an agent-authored post. A person's message is
  // never excused here: a person typing into a channel an agent is engaged in is
  // the case `engaged` exists for.
  if (entry.authorKind !== 'agent') return null;

  // R2. A colleague answering somebody else's question. `answersEntryId` is
  // stamped on every agent-authored post a turn produces, so this is a fact
  // rather than a guess — and E2 says that exchange is not ours. It is also the
  // shape that produces the deepest cascades: under DOR-1434's raised ceiling
  // one question can bounce between two agents for ten hops, and today a third
  // engaged agent buys ten turns to say nothing about it.
  //
  // **Unless the question named US.** `@ana @nova what do you think?` asked both,
  // and Ana replying first does not discharge Nova's half of it — see
  // {@link RoutedEntry.answeredEntryMentionsThisAgent}.
  if (
    entry.answersEntryId !== null &&
    !entry.answersThisAgent &&
    !entry.answeredEntryMentionsThisAgent
  ) {
    return 'colleagues_answer';
  }

  // R3. A colleague acknowledging something this agent said. An answer is not a
  // question, and nothing in it asked for another one. The cascade guard's
  // ancestry rule used to catch most of this before it went ten deep.
  if (entry.answersThisAgent) return 'own_cascade_echo';

  return null;
}
