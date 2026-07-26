/**
 * The guard's absence is invisible except under a cascade, so this file builds
 * one: two `always` agents in one room, driven around the loop the way R3 will
 * drive it, and asserted to stop.
 *
 * The loop below is deliberately written out rather than called, because R1
 * ships the rule and R3 ships the wiring. If the two ever disagree, this test
 * is what says so.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { selectTriggerTargets, type AddressingMember } from '../addressing.js';
import {
  buildCascadeNotice,
  deriveCascade,
  evaluateCascade,
  DEFAULT_MAX_AGENT_DEPTH,
  type CascadeRefusalReason,
} from '../cascade-guard.js';
import { AuthorRegistry } from '../author-registry.js';
import { RoomService } from '../room-service.js';
import type { RoomAgentLookup } from '../room-errors.js';
import { RoomStore } from '../room-store.js';
import { RoomBroadcaster } from '../room-stream.js';

const AGENTS: Record<string, { name: string; displayName: string }> = {
  '/agents/ana': { name: 'ana', displayName: 'Ana' },
  '/agents/bo': { name: 'bo', displayName: 'Bo' },
};

/** Every agent answers everything — the worst case the guard exists for. */
const alwaysAgents: RoomAgentLookup = {
  byPath: (agentPath) => {
    const agent = AGENTS[agentPath];
    return agent ? { ...agent, responseMode: 'always' } : null;
  },
};

/** One turn of the cascade the guard bounds, as R3 will drive it. */
interface CascadeRun {
  refusals: Array<{ authorId: string; reason: CascadeRefusalReason; depth: number }>;
  rounds: number;
}

describe('cascade guard', () => {
  let db: Db;
  let service: RoomService;
  let authors: AuthorRegistry;
  let room: RoomWithRoster;
  let ana: string;
  let bo: string;
  let human: string;

  beforeEach(() => {
    db = createTestDb();
    authors = new AuthorRegistry(db);
    service = new RoomService({
      store: new RoomStore(db),
      authors,
      broadcaster: new RoomBroadcaster(),
      agents: alwaysAgents,
    });

    human = authors.localHuman().id;
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;

    room = service.createRoom({ kind: 'channel', title: 'Backend', members: [] }, human);
    // Both agents answer everything, in a channel. Without a guard this loops
    // until somebody notices the bill.
    service.addMember(room.id, { agentPath: '/agents/ana', responseMode: 'always' });
    service.addMember(room.id, { agentPath: '/agents/bo', responseMode: 'always' });
  });

  /** The roster as addressing sees it. */
  function members(): AddressingMember[] {
    const current = service.getRoom(room.id);
    return (current?.members ?? []).map((m) => ({
      authorId: m.authorId,
      kind: m.author.kind,
      responseMode: m.responseMode,
    }));
  }

  /**
   * Drive the cascade to exhaustion: trigger everyone addressing selects, let
   * the guard veto, write a notice for each veto, and repeat on whatever posted.
   * `maxRounds` is a test-harness tripwire, NOT the guard — if the guard works,
   * the loop runs dry long before it.
   */
  function runCascade(seed: RoomEntry, maxRounds = 10): CascadeRun {
    const refusals: CascadeRun['refusals'] = [];
    let frontier = [seed];
    let rounds = 0;

    while (frontier.length > 0 && rounds < maxRounds) {
      rounds += 1;
      const next: RoomEntry[] = [];
      for (const entry of frontier) {
        const targets = selectTriggerTargets({
          roomKind: 'channel',
          entry,
          members: members(),
        });
        for (const target of targets) {
          const decision = evaluateCascade(target, {
            root: entry.cascadeRoot,
            depth: entry.cascadeDepth,
            authorsInCascade: service.authorsInCascade(room.id, entry.cascadeRoot),
          });
          if (!decision.allowed) {
            refusals.push({
              authorId: target,
              reason: decision.reason as CascadeRefusalReason,
              depth: decision.depth,
            });
            const name = authors.getById(target)?.displayName ?? 'An agent';
            service.postNotice(room.id, buildCascadeNotice(name, target), {
              root: entry.cascadeRoot,
              depth: decision.depth,
            });
            continue;
          }
          next.push(
            service.post(room.id, {
              authorId: target,
              text: 'on it',
              trigger: { root: entry.cascadeRoot, depth: decision.depth },
            })
          );
        }
      }
      frontier = next;
    }
    return { refusals, rounds };
  }

  it('terminates a two-agent ping-pong instead of running forever', () => {
    const seed = service.post(room.id, { authorId: human, text: 'what do you two think?' });
    const run = runCascade(seed);

    // The tripwire was never reached: the guard stopped it, not the harness.
    expect(run.rounds).toBeLessThan(10);
    expect(run.refusals.length).toBeGreaterThan(0);
  });

  it('fires the ancestry rule, and fires it below the depth ceiling', () => {
    const seed = service.post(room.id, { authorId: human, text: 'thoughts?' });
    const run = runCascade(seed);

    expect(run.refusals.every((r) => r.reason === 'ancestry')).toBe(true);
    // The load-bearing claim: a pure depth counter would have permitted every
    // one of these calls and only refused at depth 4.
    expect(run.refusals.every((r) => r.depth <= DEFAULT_MAX_AGENT_DEPTH)).toBe(true);
    expect(Math.max(...run.refusals.map((r) => r.depth))).toBeLessThan(DEFAULT_MAX_AGENT_DEPTH + 1);
  });

  it('lands a durable notice in the room, in the room own voice', () => {
    const seed = service.post(room.id, { authorId: human, text: 'thoughts?' });
    runCascade(seed);

    const notices = service
      .listEntries(room.id, { limit: 100 })
      .filter((entry) => entry.kind === 'notice');

    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0].body.notice).toBe('cascade_stopped');
    expect(notices[0].body.text).toContain('automatic-reply limit');
    expect(notices[0].body.text).not.toMatch(/error|Error|undefined|null/);
    // Written by the system author, about the agent that went quiet.
    expect(notices[0].authorId).toBe(authors.system().id);
    expect([ana, bo]).toContain(notices[0].body.subjectAuthorId);
  });

  it('keeps the whole cascade traceable to the entry that began it', () => {
    const seed = service.post(room.id, { authorId: human, text: 'thoughts?' });
    runCascade(seed);

    const entries = service.listEntries(room.id, { limit: 100 });
    expect(entries.every((entry) => entry.cascadeRoot === seed.id)).toBe(true);
    expect(service.authorsInCascade(room.id, seed.id).sort()).toEqual(
      [human, ana, bo, authors.system().id].sort()
    );
  });

  it('lets a human re-engage a room the guard has stopped', () => {
    runCascade(service.post(room.id, { authorId: human, text: 'round one' }));
    const before = service.listEntries(room.id, { limit: 100 }).length;

    // A human post always starts a fresh cascade: its own id at depth 0.
    const second = service.post(room.id, { authorId: human, text: 'round two' });
    expect(second.cascadeRoot).toBe(second.id);
    expect(second.cascadeDepth).toBe(0);

    const run = runCascade(second);
    expect(service.listEntries(room.id, { limit: 200 }).length).toBeGreaterThan(before + 1);
    expect(run.refusals.length).toBeGreaterThan(0);
  });
});

describe('evaluateCascade', () => {
  const provenance = { root: 'E0', depth: 0, authorsInCascade: ['human'] as string[] };

  it('allows a first trigger', () => {
    expect(evaluateCascade('ana', provenance)).toEqual({ allowed: true, depth: 1 });
  });

  it('refuses past the depth ceiling even when nobody repeats', () => {
    const decision = evaluateCascade('fresh-agent', {
      root: 'E0',
      depth: DEFAULT_MAX_AGENT_DEPTH,
      authorsInCascade: ['human', 'a', 'b', 'c'],
    });
    expect(decision).toEqual({
      allowed: false,
      depth: DEFAULT_MAX_AGENT_DEPTH + 1,
      reason: 'depth',
    });
  });

  it('refuses a repeat author well inside the ceiling', () => {
    expect(evaluateCascade('ana', { ...provenance, authorsInCascade: ['human', 'ana'] })).toEqual({
      allowed: false,
      depth: 1,
      reason: 'ancestry',
    });
  });

  it('honours a caller-supplied ceiling', () => {
    expect(evaluateCascade('ana', provenance, { maxAgentDepth: 0 }).reason).toBe('depth');
  });
});

describe('deriveCascade', () => {
  it('starts an untriggered post fresh, at its own id and depth 0', () => {
    expect(deriveCascade('E7')).toEqual({ cascadeRoot: 'E7', cascadeDepth: 0 });
  });

  it('inherits the trigger provenance when there is one', () => {
    expect(deriveCascade('E7', { root: 'E0', depth: 2 })).toEqual({
      cascadeRoot: 'E0',
      cascadeDepth: 2,
    });
  });
});
