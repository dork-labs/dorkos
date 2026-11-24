/**
 * How long a claim lives, and what the room believes while it is alive.
 *
 * A claim is the only live record that an agent is working. It used to die when
 * `runner.run()` resolved — which for a slow turn is the moment the room stops
 * WAITING, not the moment the turn ends. On the shipped settings that left up to
 * fifty minutes (ceiling 60 − wait 10) in which an agent was demonstrably
 * mid-turn and read as idle to everything that asks: the cascade guard's
 * in-flight union, every room-mate's `room_context.working`, and — once the
 * presence signal lands on top of this — the person waiting for the answer.
 *
 * So the rule these tests pin is one sentence: **a claim lives until its turn
 * reaches a terminal**, and every way a turn can reach one releases it.
 *
 * The second half of this file pins what the ROOM says while that is going on.
 * Presence is the claim map made visible: a `progress` signal at the claim,
 * another at the wait deadline, one more when the turn ends, and a re-statement
 * every ten seconds in between so a client that connects mid-turn is not left
 * looking at a room that seems idle. Two properties there are worth more than
 * the rest, and both are asserted on the ORDER of the room's own stream rather
 * than on a mock: an indicator never drops before the entry that explains it,
 * and an indicator's age is measured from when the work started, not from when
 * the last event was sent.
 *
 * Everything below runs through the real service and the real dispatcher, like
 * the cascade tests; only the runner stands in, because the alternative is a
 * model call. What this file's runner adds over `outcomeRunner` is control of
 * TIME: a turn can be held past the deadline and landed when the test says so,
 * and a turn can be gated so that the order of two turns is a fact rather than a
 * coin flip. That second one is not decoration — roster order breaks a
 * `joinedAt` tie on a random ULID, so a test that depends on which of two agents
 * answers first passes about half the time (`room-silence.test.ts` says the same
 * at more length).
 *
 * Spec: `specs/room-presence/02-specification.md` §3.1, §4.1.
 *
 * @module server/services/rooms/__tests__/room-presence-claims/room-presence-claims.fixtures
 */

import { vi } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type {
  RoomEntry,
  RoomEvent,
  RoomSignalEvent,
  RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { deriveSessionActivity } from '../../../session/index.js';
import type { AuthorRegistry } from '../../author-registry.js';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import type { RoomService } from '../../room-service.js';
import type { LateRoomReply, RoomTurnRequest, RoomTurnResult } from '../../room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  type RecordedTurn,
  type ScriptedTurnRunner,
  roomVoice,
} from '../room-test-harness.js';

/** The agents these rooms are built from. */

export const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'always' },
});

/** What one turn does when the dispatcher asks for it. */
export type TurnPlan =
  /** Outruns the room's wait: returns `{ text: null, late }` and keeps running. */
  | 'hold'
  /** Answers straight away. */
  | 'answer'
  /** Never ran: another writer held the session, so the room says so instead. */
  | 'busy'
  /** Blows up before it can produce anything — the runtime-is-down path. */
  | 'throws'
  /** Answers only once the test releases it, which fixes the order of two turns. */
  | 'gated';

/** A scripted runner whose turns the test finishes by hand. */
export interface DrivenRunner extends ScriptedTurnRunner {
  /** Land the oldest held turn's answer, the way a late turn closing does. */
  land(authorId: string, reply: LateRoomReply): void;
  /** Blow up the oldest held turn's delivery — the infrastructure-failure path. */
  fail(authorId: string, err: Error): void;
  /** Let a gated turn answer now. */
  release(authorId: string): void;
  /** How many of this agent's turns are still being held. */
  holdsFor(authorId: string): number;
  /**
   * Say what this agent's live turn is doing, exactly as the real runner does.
   *
   * The tool NAME and INPUT go in, not a reading: the derivation is the
   * session's own {@link deriveSessionActivity}, so these tests read the
   * basename rule, the first-line rule and the 40-character truncation rather
   * than a value the test seeded. Breaking that function is what makes them red.
   *
   * @param authorId - Whose turn is doing something.
   * @param toolName - The tool it just started.
   * @param input - That tool's JSON input, when it has one.
   */
  doing(authorId: string, toolName: string, input?: string): void;
  /** Say this agent's turn is no longer doing anything nameable. */
  stoppedDoing(authorId: string): void;
}

/** One held turn, waiting for the test to finish it one way or the other. */
export interface HeldTurn {
  land(reply: LateRoomReply): void;
  fail(err: Error): void;
  /** The turn itself, so landing it can say its words in the room. */
  request: RoomTurnRequest;
}

/**
 * Build the runner these tests drive.
 *
 * Every hand-off throws when there is nothing to hand off to. A `land` that
 * silently did nothing because the turn was never held would leave a test
 * asserting about a room that never moved, which is the failure mode a test
 * helper must not have.
 *
 * **Held turns queue per agent rather than overwrite.** A map keyed by author
 * silently dropped a second hold, which is exactly the shape a test about
 * double-triggering must be able to SEE rather than lose: the dispatcher now
 * refuses a second turn for an agent already working in a room, and a runner
 * that could not represent two would agree with a broken one. Landing takes the
 * OLDEST outstanding hold, which is the order a room finishes them in.
 *
 * @param opts.plan - What each turn does, by request.
 * @param opts.say - What an answering turn says. `'on it'` by default.
 */
export function drivenRunner(opts: {
  plan(request: RoomTurnRequest): TurnPlan;
  say?(request: RoomTurnRequest): string | null;
}): DrivenRunner {
  const turns: RecordedTurn[] = [];
  const voice = roomVoice();
  const held = new Map<string, HeldTurn[]>();
  const gates = new Map<string, () => void>();
  /** Each live turn's activity callback, by the agent running it. */
  const reporters = new Map<string, (activity: SessionActivity | null) => void>();
  const say = opts.say ?? ((): string => 'on it');
  /**
   * Take this agent's oldest outstanding hold.
   *
   * @param authorId - Whose turn is being finished.
   * @param verb - What the caller was trying to do, for the error.
   */
  function takeHeld(authorId: string, verb: string): HeldTurn {
    const turn = held.get(authorId)?.shift();
    if (!turn) throw new Error(`no turn is being held for ${authorId}, so it cannot ${verb}`);
    return turn;
  }
  /**
   * Say a turn's words in the room, the way a real one does.
   *
   * **Nothing posts a turn's text for it** (spec `tool-only-room-replies`), so a
   * scripted turn that means to be heard has to call the tool — and these tests
   * are almost all about what the room shows while a turn runs and when it
   * releases, which only means anything if something lands.
   *
   * @param request - The turn saying it.
   * @param said - Its words, or `null`/blank for a turn that says nothing.
   * @param unanswered - Set when the turn was refused rather than run, in which
   *   case there is nothing to say.
   */
  function speak(request: RoomTurnRequest, said: string | null, unanswered?: unknown): void {
    if (unanswered !== undefined) return;
    if (said === null || said.trim() === '') return;
    voice.sayInRoom(request, said);
  }
  return {
    turns,
    interrupted: [],
    ...voice,
    interrupt: () => Promise.resolve(mockInterruptReceipt('not-running')),
    land(authorId, reply) {
      const turn = takeHeld(authorId, 'land');
      speak(turn.request, reply.text, reply.unanswered);
      turn.land(reply);
    },
    fail(authorId, err) {
      takeHeld(authorId, 'fail').fail(err);
    },
    holdsFor(authorId) {
      return held.get(authorId)?.length ?? 0;
    },
    doing(authorId, toolName, input) {
      const report = reporters.get(authorId);
      if (!report) throw new Error(`no turn is running for ${authorId}, so it cannot be doing`);
      report(deriveSessionActivity(toolName, input) ?? null);
    },
    stoppedDoing(authorId) {
      const report = reporters.get(authorId);
      if (!report) throw new Error(`no turn is running for ${authorId}, so it cannot stop`);
      report(null);
    },
    release(authorId) {
      const open = gates.get(authorId);
      if (!open) throw new Error(`no turn is waiting to be released for ${authorId}`);
      open();
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      reporters.set(request.authorId, request.onActivity);
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        cwd: request.cwd,
        sessionId: request.sessionId,
        prompt: request.entry.body.text,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
      });
      // Bound at claim time, so this is never actually null in a triggered turn.
      const sessionId = request.sessionId ?? `session-${request.authorId}`;
      switch (opts.plan(request)) {
        case 'hold': {
          const late = new Promise<LateRoomReply>((resolve, reject) => {
            const queue = held.get(request.authorId) ?? [];
            queue.push({ land: resolve, fail: reject, request });
            held.set(request.authorId, queue);
          });
          // Exactly what `room-turn-runner.ts` returns at the wait deadline: the
          // room has no answer yet, and one is still coming.
          return Promise.resolve({ sessionId, text: null, late });
        }
        case 'busy':
          // What `room-turn-runner.ts` returns when the session lock refuses: no
          // turn ran, and the room owes the person a line about it.
          return Promise.resolve({ sessionId, text: null, unanswered: 'busy' });
        case 'throws':
          // The runner REJECTING, which is a different terminal from a turn that
          // returns `unanswered`: it lands in `runOne`'s `catch` rather than in
          // `deliver`, and is the only terminal that reaches the release without
          // passing through `deliver` at all.
          return Promise.reject(new Error('the runtime went away'));
        case 'gated':
          return new Promise<RoomTurnResult>((resolve) => {
            gates.set(request.authorId, () => {
              const said = say(request);
              speak(request, said);
              resolve({ sessionId, text: said });
            });
          });
        default: {
          const said = say(request);
          speak(request, said);
          return Promise.resolve({ sessionId, text: said });
        }
      }
    },
  };
}

export let service: RoomService;
export let authors: AuthorRegistry;
export let runner: DrivenRunner;
export let room: RoomWithRoster;
export let ana: string;
export let bo: string;
export let cy: string;
export let human: string;
/**
 * Everything the room fanned out, in the order its readers received it.
 *
 * Recorded at the broadcaster — the one seam every entry and every signal
 * passes through — and still delivered, so this observes the real stream
 * rather than replacing it. Order is the whole point: "the answer lands, then
 * the indicator goes" is a claim about this list and about nothing else.
 */
export let published: Array<{ roomId: string; event: RoomEvent }> = [];

/**
 * Wire a channel holding Ana, Bo and Cy around `driven`, every one of them
 * answering only when named.
 *
 * `mention-only` is set explicitly by default, and the reason is the thing
 * these tests are about. A channel now seeds `engaged` (`room-roster.ts`), so
 * an agent stays answerable for ten minutes after being addressed — which
 * means the SECOND message of a scenario reaches the agent whose turn is still
 * being held. A scenario about one held turn then measures a refusal it never
 * asked about. Naming each target makes who runs a property of the message
 * rather than of a window.
 *
 * Pass `'seeded'` to leave the channel's own default in place. One test WANTS
 * that re-trigger, because refusing it is the fix for DOR-752 — and pinning
 * `mention-only` everywhere is exactly what hid the double turn for so long.
 *
 * @param driven - The runner standing in for the turn machinery.
 * @param responseMode - What every agent's membership is set to, or `'seeded'`
 *   to keep whatever opening a channel gives them.
 */
export function open(
  driven: DrivenRunner,
  responseMode: ResponseMode | 'seeded' = 'mention-only'
): void {
  ({ service, authors, human } = createRoomHarness({ agents, runner: driven }));
  runner = driven;
  published = [];
  const broadcaster = service.stream;
  const deliver = broadcaster.publish.bind(broadcaster);
  vi.spyOn(broadcaster, 'publish').mockImplementation((roomId, event) => {
    published.push({ roomId, event });
    deliver(roomId, event);
  });
  room = service.createRoom(
    {
      kind: 'channel',
      title: 'Backend',
      members: [],
      agentPaths: ['/agents/ana', '/agents/bo', '/agents/cy'],
    },
    human
  );
  ana = authors.resolveAgent('/agents/ana', 'Ana').id;
  bo = authors.resolveAgent('/agents/bo', 'Bo').id;
  cy = authors.resolveAgent('/agents/cy', 'Cy').id;
  if (responseMode === 'seeded') return;
  for (const authorId of [ana, bo, cy]) {
    service.updateMembership(room.id, human, authorId, responseMode);
  }
}

/** Every entry in the room, oldest first. */
export function log(): RoomEntry[] {
  return service.listEntries(room.id, human, { limit: 200 });
}

/** Just the notices — the room speaking in its own voice. */
export function notices(): RoomEntry[] {
  return log().filter((entry) => entry.kind === 'notice');
}

/** The notices about one agent. */
export function noticesAbout(authorId: string): RoomEntry[] {
  return notices().filter((entry) => entry.body.subjectAuthorId === authorId);
}

/** Posts by one author. */
export function postsBy(authorId: string): RoomEntry[] {
  return log().filter((entry) => entry.kind === 'post' && entry.authorId === authorId);
}

/** The turns one agent was asked to run. */
export function turnsBy(authorId: string): RecordedTurn[] {
  return runner.turns.filter((turn) => turn.authorId === authorId);
}

/**
 * Who the agent running `turn` was told is already working in this room.
 *
 * This is the observable the whole lifetime fix is about: `room_context.working`
 * is derived from the live claim map at the moment a turn is handed its
 * context, so a claim that has been dropped early is a colleague this list
 * cannot mention.
 *
 * @param turn - The recorded turn whose context is being read.
 */
export function workingSeenBy(turn: RecordedTurn | undefined): string[] {
  return (turn?.roomContext.working ?? []).map((claim) => claim.displayName);
}

/** This room's stream, entries and signals interleaved, in order. */
export function roomStream(): RoomEvent[] {
  return published.filter((sent) => sent.roomId === room.id).map((sent) => sent.event);
}

/** Every presence signal about one agent, in the order it was sent. */
export function presenceFor(authorId: string): RoomSignalEvent[] {
  return roomStream()
    .filter((event): event is RoomSignalEvent => event.type === 'signal')
    .filter((event) => event.authorId === authorId);
}

/** Just the lifecycle, which is what most of these assertions are about. */
export function statesFor(authorId: string): Array<string | undefined> {
  return presenceFor(authorId).map((event) => event.state);
}

/**
 * The room's stream without its `reaction` events, for the ordering checks.
 *
 * The room takes its 👀 receipt off the asked message as the turn ends
 * (DOR-2823), and that `reaction` event lands between the answer and the
 * release. No test here reacts, so every `reaction` event is a receipt.
 */
export function orderedStream(): RoomEvent[] {
  return roomStream().filter((event) => event.type !== 'reaction');
}

/**
 * Where one agent's release sits in the room's stream.
 *
 * @param authorId - Whose indicator released.
 */
export function releaseIndex(authorId: string): number {
  return orderedStream().findIndex(
    (event) => event.type === 'signal' && event.authorId === authorId && event.state === 'done'
  );
}

/**
 * Where the durable entry that explains a release sits in the same stream.
 *
 * @param matches - Which entry is being looked for.
 */
export function entryIndex(matches: (entry: RoomEntry) => boolean): number {
  return orderedStream().findIndex((event) => event.type === 'entry' && matches(event.entry));
}
