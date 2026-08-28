/**
 * Tier 1 of the engaged response gate, rule by rule (spec
 * `engaged-response-gate` §4, §10.1).
 *
 * Every case here is a `no` or a `null`, because those are the only two things
 * this module can produce. The cases that matter most are the NEGATIVE ones —
 * the messages a rule must NOT excuse — since a false `no` is an agent that went
 * quiet and said nothing about it, and nothing downstream can recover a
 * contribution that was never made.
 */
import { describe, it, expect } from 'vitest';
import { routeAmbient, type RoutedEntry, type RoutingInput } from '../routing-rules.js';

/** The agent being judged, and its room-mates. */
const ME = 'ana';
const AGENTS = new Set([ME, 'nova', 'ace']);

/** One message, with the defaults of an ordinary human post that names nobody. */
function post(overrides: Partial<RoutedEntry> = {}): RoutedEntry {
  return {
    entryId: 'e1',
    authorId: 'dorian',
    authorKind: 'human',
    mentions: [],
    answersEntryId: null,
    answersThisAgent: false,
    answeredEntryMentionsThisAgent: false,
    ...overrides,
  };
}

/** Judge one burst on the standard roster. */
function route(entries: RoutedEntry[], input: Partial<RoutingInput> = {}) {
  return routeAmbient({ agentAuthorId: ME, agentMembers: AGENTS, entries, ...input });
}

describe('R1 — named_other_agent', () => {
  it('excuses a post that named a different agent in this room', () => {
    // `@nova ship the release` reaches Nova AND every other engaged agent in the
    // channel today, each of which spends a whole turn deciding to stay out.
    expect(route([post({ mentions: ['nova'] })])).toEqual({
      verdict: 'no',
      rule: 'named_other_agent',
    });
  });

  it('does NOT excuse a post that named this agent', () => {
    expect(route([post({ mentions: ['ana'] })])).toBeNull();
  });

  it('does NOT excuse a post that named this agent alongside another', () => {
    // `@nova @ana can one of you look?` addressed both. Being named beats every
    // rule here — the caller will not even offer such a burst, and this pins the
    // property locally as well.
    expect(route([post({ mentions: ['nova', 'ana'] })])).toBeNull();
  });

  it('does NOT excuse a post that named a PERSON', () => {
    // The blast-radius carve-out. `@kai can you look at this?` is a question put
    // to a colleague in the room; it delegates nothing to an agent, and an agent
    // already in the conversation has no reason to step out of it.
    expect(route([post({ mentions: ['dorian'] })])).toBeNull();
  });

  it('does NOT excuse a post that named somebody who is not in this room', () => {
    // A name that resolved to an author outside the roster cannot be the agent
    // this question was handed to.
    expect(route([post({ mentions: ['stranger'] })])).toBeNull();
  });

  it('excuses a mention of another agent even when this agent wrote nothing yet', () => {
    expect(route([post({ authorKind: 'agent', authorId: 'nova', mentions: ['ace'] })])).toEqual({
      verdict: 'no',
      rule: 'named_other_agent',
    });
  });

  /**
   * The accepted miss, written down rather than discovered later.
   *
   * A post that names another agent AND genuinely needs this one — *"@nova ship
   * the release"* when this agent is the one that knows the release is blocked —
   * is routed to silence, and the useful interjection never happens. That is a
   * real cost and it is the number `specs/engaged-response-gate` §10.4 says to
   * measure first, countable from the refusal ledger with no model spend at all.
   *
   * It is accepted for three reasons: `standDownFallbackSeat` already makes
   * exactly this call for the fallback seat and the room's design record says it
   * must; the engaged window is short, so the exposure is minutes rather than
   * forever; and naming the agent — which is what a person does when they want
   * it — takes the message straight back out of the gate's reach.
   */
  it('accepted miss: silences an agent that had something to add, because the post named somebody else', () => {
    expect(route([post({ mentions: ['nova'] })])).toEqual({
      verdict: 'no',
      rule: 'named_other_agent',
    });
  });
});

describe('R2 — colleagues_answer', () => {
  it("excuses an agent's reply to somebody else's question", () => {
    expect(route([post({ authorId: 'nova', authorKind: 'agent', answersEntryId: 'q1' })])).toEqual({
      verdict: 'no',
      rule: 'colleagues_answer',
    });
  });

  it('does NOT excuse a HUMAN reply, however it is threaded', () => {
    // A person typing into a channel this agent is engaged in is the whole case
    // `engaged` exists for.
    expect(
      route([post({ authorId: 'dorian', authorKind: 'human', answersEntryId: 'q1' })])
    ).toBeNull();
  });

  it("does NOT excuse an agent's post that answers nothing", () => {
    // An out-of-turn update is not an answer, and nothing says it is not for us.
    expect(route([post({ authorId: 'nova', authorKind: 'agent' })])).toBeNull();
  });

  it('does NOT excuse a reply that named this agent', () => {
    expect(
      route([
        post({ authorId: 'nova', authorKind: 'agent', answersEntryId: 'q1', mentions: ['ana'] }),
      ])
    ).toBeNull();
  });

  it('does NOT excuse a reply to a question that NAMED this agent', () => {
    // `@ana @nova what do you think?` asked both. Ana answering first does not
    // discharge Nova's half of it, so Nova still runs — one extra turn against
    // silently dropping a direct ask.
    expect(
      route([
        post({
          authorId: 'nova',
          authorKind: 'agent',
          answersEntryId: 'q1',
          answeredEntryMentionsThisAgent: true,
        }),
      ])
    ).toBeNull();
  });

  it('DOES excuse a reply to a question that named only somebody else', () => {
    // The other half of the same pair, so the carve-out above cannot quietly
    // widen into "never excuse a reply".
    expect(
      route([
        post({
          authorId: 'nova',
          authorKind: 'agent',
          answersEntryId: 'q1',
          answeredEntryMentionsThisAgent: false,
        }),
      ])
    ).toEqual({ verdict: 'no', rule: 'colleagues_answer' });
  });

  it('reads an author whose row has vanished as `system`, and excuses nothing', () => {
    expect(route([post({ authorKind: 'system', answersEntryId: 'q1' })])).toBeNull();
  });
});

describe('R3 — own_cascade_echo', () => {
  it('excuses a colleague acknowledging something this agent said', () => {
    expect(
      route([
        post({
          authorId: 'nova',
          authorKind: 'agent',
          answersEntryId: 'mine',
          answersThisAgent: true,
        }),
      ])
    ).toEqual({ verdict: 'no', rule: 'own_cascade_echo' });
  });

  it('does NOT excuse it when the acknowledgement asks this agent something', () => {
    expect(
      route([
        post({
          authorId: 'nova',
          authorKind: 'agent',
          answersEntryId: 'mine',
          answersThisAgent: true,
          mentions: ['ana'],
        }),
      ])
    ).toBeNull();
  });

  it('does NOT excuse a PERSON answering this agent', () => {
    expect(
      route([post({ authorKind: 'human', answersEntryId: 'mine', answersThisAgent: true })])
    ).toBeNull();
  });
});

describe('the burst is judged as a whole', () => {
  it('excuses a burst whose messages match DIFFERENT rules', () => {
    // A turn answers a moment rather than a message, so every message has to be
    // excusable — but they need not be excusable for the same reason.
    const verdict = route([
      post({ entryId: 'a', mentions: ['nova'] }),
      post({ entryId: 'b', authorId: 'nova', authorKind: 'agent', answersEntryId: 'a' }),
    ]);
    // The reported rule is the NEWEST message's, because that is the one the
    // turn would have been answering.
    expect(verdict).toEqual({ verdict: 'no', rule: 'colleagues_answer' });
  });

  it('passes the whole burst through when ONE message is not excusable', () => {
    expect(
      route([
        post({ entryId: 'a', mentions: ['nova'] }),
        post({ entryId: 'b' }),
        post({ entryId: 'c', mentions: ['ace'] }),
      ])
    ).toBeNull();
  });

  it('has no opinion about an empty burst', () => {
    // Unreachable — a collection exists because a message opened it — but "no
    // messages" is not evidence that there was nothing to say.
    expect(route([])).toBeNull();
  });
});

describe('what tier 1 never reads', () => {
  it('ignores message text entirely, so it has no injection surface', () => {
    // Every input is resolved at write time by machinery no message body
    // reaches. There is no text field on `RoutedEntry` to pass, which is the
    // real assertion; this pins that the shape has not grown one.
    const entry = post({ mentions: ['nova'] });
    expect(Object.keys(entry).sort()).toEqual([
      'answeredEntryMentionsThisAgent',
      'answersEntryId',
      'answersThisAgent',
      'authorId',
      'authorKind',
      'entryId',
      'mentions',
    ]);
  });
});
