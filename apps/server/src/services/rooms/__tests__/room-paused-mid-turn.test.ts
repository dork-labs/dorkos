/**
 * Pausing an agent while its room turn is running (DOR-3178).
 *
 * The pause stops the runtime, and the turn ends the way any interrupted turn
 * does: unanswered, or thrown with whatever the runtime said. The room used to
 * read that as a crash ("ran into a problem and could not answer here"). It
 * should say the agent was paused, once, and a real failure must still read as
 * one.
 *
 * Driven through the real room service and dispatcher and the real pause
 * service: pausing interrupts the live turn it tracked, and only the runner
 * stands in for the runtime underneath.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { setAgentHomeRegistry } from '../../core/agent-identity/agent-home.js';
import {
  AgentPauseService,
  initAgentPause,
  resetAgentPause,
} from '../../mesh/pause/agent-pause.js';
import type { RoomService } from '../room-service.js';
import type { RoomTurnRequest, RoomTurnResult } from '../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const ANA = { id: '01ANAAGENTULID00000000000', home: '/agents/ana' } as const;
const BO = { id: '01BOAGENTULID000000000000', home: '/agents/bo' } as const;
const PERSON: AuditActor = { accountId: 'install:inst-1', kind: 'person', name: 'Dana' };
const AGENT: AuditActor = { accountId: BO.id, kind: 'agent', name: 'Bo' };

const lookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** How the turn ends once the pause interrupts it. */
type Ending = { unanswered: 'failed' } | { throws: Error };

/**
 * A runner whose turn runs until something interrupts it, then ends as
 * `ending` says, the way a runtime's interrupted turn comes back. The turn is
 * tracked with the pause service exactly as the runtime seam tracks one, so a
 * pause reaches it through `interruptTurnsOf`, not through the test.
 */
function interruptibleRunner(
  pauses: AgentPauseService,
  ending: Ending
): { runner: ScriptedTurnRunner; running: Promise<void> } {
  const base = outcomeRunner(() =>
    'throws' in ending ? { throws: ending.throws } : { text: null, unanswered: 'failed' }
  );
  let markRunning: () => void = () => undefined;
  const running = new Promise<void>((resolve) => {
    markRunning = resolve;
  });
  const runner: ScriptedTurnRunner = {
    ...base,
    async run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      await new Promise<void>((interrupted) => {
        const forget = pauses.trackTurn({
          sessionId: request.sessionId ?? 'session-ana',
          opts: { forAgent: request.agentPath },
          interrupt: async () => {
            forget();
            interrupted();
            return { outcome: 'acked' };
          },
        });
        markRunning();
      });
      return base.run(request);
    },
  };
  return { runner, running };
}

describe('pausing an agent in the middle of its room turn (DOR-3178)', () => {
  let db: Db;
  let pauses: AgentPauseService;
  let service: RoomService;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    for (const [agent, name] of [
      [ANA, 'Ana'],
      [BO, 'Bo'],
    ] as const) {
      db.insert(agents)
        .values({
          id: agent.id,
          name: name.toLowerCase(),
          displayName: name,
          runtime: 'claude-code',
          projectPath: agent.home,
          registeredAt: now,
          updatedAt: now,
        })
        .run();
    }
    setAgentHomeRegistry({
      isRegisteredHome: (dir) => dir === ANA.home || dir === BO.home,
      listRegisteredHomes: () => [ANA.home, BO.home],
      managedWorkspaceOwner: () => null,
      roomsDir: null,
    });
    pauses = new AgentPauseService({ db });
    initAgentPause(pauses);
  });

  afterEach(() => {
    resetAgentPause();
    setAgentHomeRegistry(undefined);
  });

  function open(runner: ScriptedTurnRunner): void {
    const harness = createRoomHarness({ agents: lookup, runner });
    ({ service, human } = harness);
    room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA.home] },
      human
    );
    ana = harness.authors.resolveAgent(ANA.home, 'Ana').id;
    service.updateMembership(room.id, human, ana, 'always');
  }

  function noticesAboutAna(): RoomEntry[] {
    return service
      .listEntries(room.id, human, { limit: 200 })
      .filter((entry) => entry.kind === 'notice' && entry.body.subjectAuthorId === ana);
  }

  async function pauseMidTurn(running: Promise<void>, by: AuditActor = PERSON): Promise<void> {
    service.post(room.id, { authorId: human, text: 'is the build green?' });
    await running;
    const result = await pauses.pause(ANA.id, by);
    // The pause reached the live turn itself, which is the path under test.
    expect(result.stoppedTurns).toBe(1);
    await service.triggersIdle();
  }

  it('says the agent was paused, not that it ran into a problem, when the turn ends unanswered', async () => {
    const { runner, running } = interruptibleRunner(pauses, { unanswered: 'failed' });
    open(runner);
    await pauseMidTurn(running);

    expect(noticesAboutAna().map((entry) => entry.body.notice)).toEqual(['agent_paused']);
    expect(noticesAboutAna()[0]!.body.text).toBe('Dana paused Ana, so this turn stopped.');
  });

  it('says the agent was paused, naming nobody, when no person paused it', async () => {
    const { runner, running } = interruptibleRunner(pauses, { unanswered: 'failed' });
    open(runner);
    await pauseMidTurn(running, AGENT);

    expect(noticesAboutAna().map((entry) => entry.body.text)).toEqual([
      'Ana was paused, so this turn stopped.',
    ]);
  });

  it('still reports a failure as one when only another agent is paused', async () => {
    await pauses.pause(BO.id, PERSON);
    open(outcomeRunner(() => ({ text: null, unanswered: 'failed' })));
    service.post(room.id, { authorId: human, text: 'is the build green?' });
    await service.triggersIdle();

    expect(noticesAboutAna().map((entry) => entry.body.notice)).toEqual(['turn_failed']);
  });

  it('says the agent was paused when the stopped turn throws', async () => {
    const { runner, running } = interruptibleRunner(pauses, {
      throws: new Error('the turn was interrupted'),
    });
    open(runner);
    await pauseMidTurn(running);

    expect(noticesAboutAna().map((entry) => entry.body.notice)).toEqual(['agent_paused']);
  });

  it('says it once when the next message meets the pause before its turn', async () => {
    const { runner, running } = interruptibleRunner(pauses, { unanswered: 'failed' });
    open(runner);
    await pauseMidTurn(running);
    // The production runner refuses a paused agent's next turn before it starts.
    runner.run = async () => {
      throw Object.assign(new Error('Ana is paused.'), {
        code: 'AGENT_PAUSED',
        pausedAt: pauses.isPaused(ANA.id)?.pausedAt,
      });
    };
    service.post(room.id, { authorId: human, text: 'and now?' });
    await service.triggersIdle();

    expect(noticesAboutAna().map((entry) => entry.body.notice)).toEqual(['agent_paused']);
  });

  it('still reports a real failure as one when nobody paused the agent', async () => {
    open(outcomeRunner(() => ({ text: null, unanswered: 'failed' })));
    service.post(room.id, { authorId: human, text: 'is the build green?' });
    await service.triggersIdle();

    expect(noticesAboutAna().map((entry) => entry.body.notice)).toEqual(['turn_failed']);
  });
});
