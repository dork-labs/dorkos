/**
 * Moments — the milestones a room marks, and the rules that keep them honest
 * (team-room-home spec D5.1).
 *
 * Two claims are load-bearing here and neither is about how a moment looks.
 * The first is that a moment is a POST: it is written into the log every other
 * entry lives in, so nothing downstream had to learn a fourth entry kind. The
 * second is that minting one buys no extra permission — a moment DorkOS writes
 * wakes nobody, and a moment an agent mints is stamped and bounded exactly like
 * anything else that agent says.
 *
 * The detectors that decide WHEN to mint one are task 4.2 and are not here. What
 * is here is the type, the write path, and every refusal that path makes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomEntry, RoomMoment, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import { RoomError } from '../room-errors.js';
import type { RoomService } from '../room-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const TANGERINES = '/agents/tangerines';
const ANA = '/agents/ana';

/** Both answer everything — so "nothing was triggered" means the guard, not apathy. */
const agents = agentLookupFor({
  [TANGERINES]: { name: 'tangerines', displayName: 'tangerines', responseMode: 'always' },
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** The ceiling, pinned to a literal so the assertions measure a number and not a variable. */
const MAX_AGENT_DEPTH = 3;

/** A moment DorkOS itself minted, off an agent's own record. */
const JOINED: RoomMoment = {
  kind: 'joined_team',
  source: { kind: 'agent', ref: TANGERINES, observedAt: '2026-08-08T09:00:00.000Z' },
  mintedByAgentRef: null,
};

describe('moments', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  let tangerines: string;

  beforeEach(() => {
    ({ service, authors, runner, human } = createRoomHarness({
      agents,
      runner: scriptedRunner(() => 'on it'),
      maxAgentDepth: MAX_AGENT_DEPTH,
    }));
    room = service.createRoom(
      { kind: 'channel', title: 'Team', members: [], agentPaths: [TANGERINES, ANA] },
      human
    );
    ana = authors.resolveAgent(ANA, 'Ana').id;
    tangerines = authors.resolveAgent(TANGERINES, 'tangerines').id;
    // A channel seeds `engaged`, which answers inside a window. Both are moved
    // to `always` so every "nothing ran" below is the guard refusing rather
    // than a window that had not opened.
    service.updateMembership(room.id, human, ana, 'always');
    service.updateMembership(room.id, human, tangerines, 'always');
  });

  /** Every entry in the room, oldest first. */
  function log(): RoomEntry[] {
    return service.listEntries(room.id, human, { limit: 200 });
  }

  it('writes a moment as a post, carrying what it was derived from', () => {
    const entry = service.postMoment(room.id, {
      text: 'tangerines joined your team',
      moment: JOINED,
      subjectAuthorId: tangerines,
    });

    // A post, not a fourth entry kind — which is what lets the history page,
    // the stream and a bridge carry it with no new branch.
    expect(entry.kind).toBe('post');
    expect(entry.authorId).toBe(authors.system().id);
    expect(entry.body.text).toBe('tangerines joined your team');
    expect(entry.body.moment).toEqual(JOINED);
    // Written by the room's own voice, ABOUT the agent it names — the same
    // field a notice uses, so the feed can draw the right face.
    expect(entry.body.subjectAuthorId).toBe(tangerines);
    expect(log().at(-1)?.id).toBe(entry.id);
  });

  it('wakes nobody — a milestone is news, not a question', async () => {
    // The control, so "nothing ran" cannot pass in a room where nothing ever
    // runs: two agents on `always` live here, and a line from a person wakes
    // them.
    service.post(room.id, { authorId: human, text: 'morning' });
    await service.triggersIdle();
    const woken = runner.turns.length;
    expect(woken).toBeGreaterThan(0);

    service.postMoment(room.id, {
      text: 'tangerines joined your team',
      moment: JOINED,
      subjectAuthorId: tangerines,
    });
    await service.triggersIdle();

    expect(runner.turns).toHaveLength(woken);
  });

  it('refuses a moment nobody could trace, and one with nothing to read', () => {
    const sourceless = { kind: 'joined_team', mintedByAgentRef: null } as unknown as RoomMoment;
    expect(() =>
      service.postMoment(room.id, { text: 'tangerines joined your team', moment: sourceless })
    ).toThrow(RoomError);
    expect(() =>
      service.postMoment(room.id, { text: '   ', moment: JOINED, subjectAuthorId: tangerines })
    ).toThrow(RoomError);
    // Neither reached the log: a refused moment leaves the room exactly as it was.
    expect(log()).toEqual([]);
  });

  it('refuses an agent-minted moment that does not name the agent that minted it', () => {
    const unsigned = { ...JOINED, kind: 'agent_minted' } as RoomMoment;
    expect(() => service.postMoment(room.id, { text: 'we shipped', moment: unsigned })).toThrow(
      RoomError
    );
  });

  it('refuses an agent minting a moment about somebody else', () => {
    // The one spoof this path could offer: an agent writing its own words under
    // another identity's face. A moment an agent mints is about its author.
    expect(() =>
      service.postMoment(room.id, {
        authorId: ana,
        text: 'tangerines joined your team',
        moment: { ...JOINED, kind: 'agent_minted', mintedByAgentRef: 'ana-ref' },
        subjectAuthorId: tangerines,
      })
    ).toThrow(RoomError);
  });

  it('bounds an agent-minted moment with the same cascade guard as any other agent post', async () => {
    const said = service.post(room.id, { authorId: ana, text: 'the build is green' });
    const minted = service.postMoment(room.id, {
      authorId: ana,
      text: 'that was our hundredth session',
      moment: {
        kind: 'agent_minted',
        source: { kind: 'session', ref: '01JZSESSION', observedAt: '2026-08-08T09:00:00.000Z' },
        mintedByAgentRef: 'ana-ref',
      },
    });
    await service.triggersIdle();

    // Un-provenanced agent writes start AT the ceiling (`deriveCascade`), so
    // anything they address is refused by the depth rule. The moment is stamped
    // exactly as the ordinary post beside it — no fresh budget for minting one.
    expect(said.cascadeDepth).toBe(MAX_AGENT_DEPTH);
    expect(minted.cascadeDepth).toBe(MAX_AGENT_DEPTH);
    expect(minted.cascadeRoot).toBe(minted.id);
    // And tangerines, on `always`, answered neither of them.
    expect(runner.turns).toEqual([]);
  });

  it('refuses to write a moment into an archived room', () => {
    service.updateRoom(room.id, human, { archived: true });
    expect(() =>
      service.postMoment(room.id, { text: 'tangerines joined your team', moment: JOINED })
    ).toThrow(RoomError);
  });
});
