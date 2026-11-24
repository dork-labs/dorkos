/**
 * A turn answers a moment, not a message (room-participation spec §10.4, RP8).
 *
 * Four mechanisms ship together here and this file pins all four:
 *
 * 1. **Collect, do not interrupt or drop.** A burst of people talking at once
 *    becomes ONE turn, gathered for `rooms.collectDebounceMs` and capped at
 *    `rooms.collectMaxEntries`. A message that arrives after the window starts
 *    the next turn instead of being folded into this one.
 * 2. **Mid-turn arrival steers.** A message for an agent that is already working
 *    here is held rather than refused, and — this is the half nothing else in
 *    the suite would catch — the claim's release RUNS it. Without that, a person
 *    who asked one more thing and stopped typing waited for a stranger to speak
 *    before their question was ever seen.
 * 3. **No in-flight peeking.** Agents never see each other's partial text. What
 *    they get is `room_context.working`, which is a name and a start time.
 * 4. **Halt is a transport verb.** It drops the gathered messages too, and it is
 *    never inferred from what somebody typed.
 *
 * Driven through the real service and the real dispatcher like the rest of the
 * rooms suite; only the runner stands in, because the alternative is a model
 * call. The collect window is pinned to a literal per test rather than read from
 * config, for the reason every other ceiling in this suite is: a test that read
 * the value the code reads could only prove the two agree.
 *
 * @module room-collect/room-collect.fixtures
 */

import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { InterruptReceipt } from '@dorkos/shared/types';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import type { AuthorRegistry } from '../../author-registry.js';
import type { RoomService } from '../../room-service.js';
import type { RoomTurnRequest, RoomTurnResult } from '../../room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  type RecordedTurn,
  type ScriptedTurnRunner,
  roomVoice,
} from '../room-test-harness.js';

export const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
});

/** The window these tests measure against, pinned rather than read from config. */
export const DEBOUNCE_MS = 500;

/** A runner whose turns only finish when the test says so. */
export interface HeldRunner extends ScriptedTurnRunner {
  /** How many of this agent's turns are still open. */
  holdsFor(authorId: string): number;
  /** Let this agent's oldest open turn answer. */
  release(authorId: string): void;
}

/**
 * Build a runner that holds every turn open until the test releases it.
 *
 * Holding is what makes any of this observable: a turn that answered would take
 * and release its claim inside one `await`, and "a message arrived while the
 * agent was working" would be a state the test never got to look at.
 *
 * @param say - What a released turn answers. The default names nobody, which is
 *   what keeps most scenarios free of cascades they did not ask for; a scenario
 *   about one agent handing work to another overrides it.
 */
export function heldRunner(say: (request: RoomTurnRequest) => string = () => 'on it'): HeldRunner {
  const turns: RecordedTurn[] = [];
  const interrupted: ScriptedTurnRunner['interrupted'] = [];
  const open = new Map<string, Array<() => void>>();
  const paths = new Map<string, string>();
  const runner: HeldRunner = {
    turns,
    interrupted,
    ...roomVoice(),
    interrupt(request): Promise<InterruptReceipt> {
      interrupted.push(request);
      // A real interrupt ENDS the turn: the runtime stops, the stream closes,
      // and the collector resolves with whatever there was. A fake that only
      // recorded the call would leave the dispatcher awaiting a turn nothing can
      // finish, which is not what a halt does.
      let stoppedSomething = false;
      for (const [authorId, queued] of open) {
        if (paths.get(authorId) !== request.agentPath) continue;
        for (const gate of queued.splice(0)) gate();
        stoppedSomething = true;
      }
      return Promise.resolve(mockInterruptReceipt(stoppedSomething ? 'acked' : 'not-running'));
    },
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      turns.push({
        roomId: request.room.id,
        authorId: request.authorId,
        agentPath: request.agentPath,
        cwd: request.cwd,
        sessionId: request.sessionId,
        prompt: request.prompt,
        roomContext: request.roomContext,
        attachmentProjection: request.attachmentProjection,
      });
      paths.set(request.authorId, request.agentPath);
      return new Promise<RoomTurnResult>((resolve) => {
        const queued = open.get(request.authorId) ?? [];
        queued.push(() => {
          // **A released turn SPEAKS through the tool**, because nothing posts a
          // turn's words for it. An interrupt releases through the same gate,
          // and the room refuses a stopped turn a post — so a halted turn still
          // leaves the room with nothing, without this fake having to know it.
          const said = say(request);
          if (said.trim() !== '') runner.sayInRoom(request, said);
          resolve({ sessionId: request.sessionId ?? 'session-1', text: said });
        });
        open.set(request.authorId, queued);
      });
    },
    holdsFor(authorId) {
      return open.get(authorId)?.length ?? 0;
    },
    release(authorId) {
      const gate = open.get(authorId)?.shift();
      if (!gate) throw new Error(`no held turn for ${authorId}`);
      gate();
    },
  };
  return runner;
}

export let service: RoomService;
export let authors: AuthorRegistry;
export let runner: ScriptedTurnRunner;
export let room: RoomWithRoster;
export let ana: string;
export let human: string;

/**
 * Wire a channel around `scripted`, with a collect window of `debounceMs`.
 *
 * @param scripted - The runner standing in for the turn machinery.
 * @param collect - The window and cap this scenario is about.
 * @param agentPaths - Who is in the room. Ana alone by default.
 * @param maxTurnsPerAgentPerCascade - How many turns one agent may take in an
 *   exchange. Left to the harness default of one unless a scenario is about
 *   the counter itself, in which case it pins its own.
 */
export function open(
  scripted: ScriptedTurnRunner,
  collect: { debounceMs: number; maxEntries: number },
  agentPaths = ['/agents/ana'],
  maxTurnsPerAgentPerCascade?: number
): void {
  ({ service, authors, runner, human } = createRoomHarness({
    agents,
    runner: scripted,
    collect,
    ...(maxTurnsPerAgentPerCascade !== undefined && { maxTurnsPerAgentPerCascade }),
  }));
  room = service.createRoom({ kind: 'channel', title: 'Backend', members: [], agentPaths }, human);
  // No lead: this case is about gathering a burst, and a lead would answer the
  // unaddressed post (DOR-2823).
  service.updateRoom(room.id, human, { leadAuthorId: null });
  ana = authors.resolveAgent('/agents/ana', 'Ana').id;
  // Named explicitly throughout, so who runs is a property of the message
  // rather than of an engagement window.
  for (const [path, name] of [
    ['/agents/ana', 'Ana'],
    ['/agents/bo', 'Bo'],
  ] as const) {
    if (!agentPaths.includes(path)) continue;
    service.updateMembership(room.id, human, authors.resolveAgent(path, name).id, 'mention-only');
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

/** Posts by one author. */
export function postsBy(authorId: string): RoomEntry[] {
  return log().filter((entry) => entry.kind === 'post' && entry.authorId === authorId);
}
