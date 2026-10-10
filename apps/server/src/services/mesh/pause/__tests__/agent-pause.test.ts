/**
 * Pausing an agent everywhere (spec `audit-trail` PR5): the service, the hold
 * at the runtime seam, and who may lift a pause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, auditEvents, type Db } from '@dorkos/db';
import type { AgentRuntime, LiveSessionRef, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { setAgentHomeRegistry } from '../../../core/agent-identity/agent-home.js';
import { decorateRuntime } from '../../../core/runtime-seam/decorate-runtime.js';
import {
  AgentPauseService,
  AgentPausedError,
  CannotResumeSelfError,
  initAgentPause,
  resetAgentPause,
} from '../agent-pause.js';

const SCOUT = { id: '01SCOUTAGENTULID0000000000', home: '/projects/scout' } as const;
const ANA = { id: '01ANAAGENTULID00000000000', home: '/projects/ana' } as const;

const PERSON: AuditActor = { accountId: 'install:inst-1', kind: 'person', name: 'Owner' };
const SCOUT_ACTOR: AuditActor = { accountId: SCOUT.id, kind: 'agent', name: 'Scout' };
const ANA_ACTOR: AuditActor = { accountId: ANA.id, kind: 'agent', name: 'Ana' };

function seed(db: Db): void {
  const now = new Date().toISOString();
  for (const [agent, name] of [
    [SCOUT, 'Scout'],
    [ANA, 'Ana'],
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
}

function rows(db: Db) {
  return db
    .select()
    .from(auditEvents)
    .all()
    .map((row) => ({
      action: row.action,
      actorId: row.actorId,
      outcome: row.outcome,
      targetId: row.targetId,
      reason: row.reason,
      error: row.error,
    }));
}

/** A fake runtime whose turn waits until it is interrupted. */
function fakeRuntime(stop: 'acked' | 'failed' = 'acked') {
  let release: (() => void) | undefined;
  let runtimeTurnListener:
    ((sessionId: string, events: AsyncIterable<StreamEvent>) => void) | undefined;
  const runtime = {
    type: 'claude-code',
    sendMessage: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }),
    executeCommandIntent: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} } as StreamEvent;
    }),
    deliverIntoTurn: vi.fn(async () => ({ delivered: true })),
    interruptQuery: vi.fn(async () => {
      if (stop === 'failed') return { outcome: 'failed', reason: 'delivery-failed' };
      release?.();
      return { outcome: 'acked', runtime: 'claude-code' };
    }),
    endSessionsWhere: vi.fn(
      async (_belongs: (session: LiveSessionRef) => boolean) => [] as string[]
    ),
    getSessionCwd: vi.fn((_sessionId: string): string | undefined => undefined),
    onRuntimeTurn: vi.fn(
      (listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void) => {
        runtimeTurnListener = listener;
        return () => {
          runtimeTurnListener = undefined;
        };
      }
    ),
    /** Open a turn the agent started on its own, as a warm process does. */
    emitRuntimeTurn(sessionId: string, events: AsyncIterable<StreamEvent>) {
      runtimeTurnListener?.(sessionId, events);
    },
  };
  return runtime;
}

/** Read a turn to its end. */
async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('AgentPauseService (spec audit-trail PR5)', () => {
  let db: Db;
  let service: AgentPauseService;

  beforeEach(() => {
    db = createTestDb();
    seed(db);
    setAgentHomeRegistry({
      isRegisteredHome: (dir) => dir === SCOUT.home || dir === ANA.home,
      listRegisteredHomes: () => [SCOUT.home, ANA.home],
      managedWorkspaceOwner: () => null,
      roomsDir: null,
    });
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    service = new AgentPauseService({ db });
    initAgentPause(service);
  });

  afterEach(() => {
    resetAgentPause();
    resetAuditTrail();
    setAgentHomeRegistry(undefined);
  });

  it('records agent.paused with who did it and why', async () => {
    const result = await service.pause(SCOUT.id, PERSON, 'posting the same thing');
    expect(result).toMatchObject({ agentId: SCOUT.id, paused: true, changed: true });
    expect(rows(db)).toEqual([
      {
        action: 'agent.paused',
        actorId: PERSON.accountId,
        outcome: 'ok',
        targetId: SCOUT.id,
        reason: 'posting the same thing',
        error: null,
      },
    ]);
    expect(service.isPaused(SCOUT.id)?.pausedBy).toEqual(PERSON);
  });

  it('interrupts a live turn of the agent, on the runtime it runs on', async () => {
    const runtime = fakeRuntime();
    const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
    const turn = wrapped.sendMessage('s1', 'go', { cwd: SCOUT.home });
    const drained = (async () => {
      for await (const _event of turn) {
        // drain
      }
    })();
    // Let the turn start and park.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await service.pause(SCOUT.id, PERSON);
    expect(runtime.interruptQuery).toHaveBeenCalledWith('s1');
    expect(result.stoppedTurns).toBe(1);
    await drained;
  });

  it('counts only the stops the runtime acknowledged', async () => {
    const runtime = fakeRuntime('failed');
    const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
    const turn = wrapped.sendMessage('s1f', 'go', { cwd: SCOUT.home });
    await turn.next();
    const result = await service.pause(SCOUT.id, PERSON);
    expect(runtime.interruptQuery).toHaveBeenCalledWith('s1f');
    expect(result.stoppedTurns).toBe(0);
    await turn.return(undefined);
  });

  it('ends the agent’s live sessions on every runtime, from each runtime’s own records', async () => {
    const live: LiveSessionRef[] = [
      { sessionId: 'warm-scout', cwd: SCOUT.home },
      { sessionId: 'warm-ana', cwd: ANA.home },
      { sessionId: 'no-cwd', cwd: undefined },
    ];
    const claude = fakeRuntime();
    claude.endSessionsWhere.mockImplementation(async (belongs) =>
      live.filter(belongs).map((session) => session.sessionId)
    );
    const codex = { ...fakeRuntime(), type: 'codex' };
    codex.endSessionsWhere.mockResolvedValue(['codex-scout']);
    const withRuntimes = new AgentPauseService({ db, runtimes: () => [claude, codex] });
    const result = await withRuntimes.pause(SCOUT.id, PERSON);
    expect(await claude.endSessionsWhere.mock.results[0]!.value).toEqual(['warm-scout']);
    expect(codex.endSessionsWhere).toHaveBeenCalledTimes(1);
    expect(result.stoppedTurns).toBe(2);
  });

  it('ends a session that ran as the agent from another folder, after its turn ended', async () => {
    const runtime = fakeRuntime();
    const withRuntimes = new AgentPauseService({ db, runtimes: () => [runtime] });
    initAgentPause(withRuntimes);
    const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
    const turn = wrapped.sendMessage('elsewhere', 'go', { cwd: '/tmp/x', forAgent: SCOUT.home });
    await turn.next();
    await turn.return(undefined);
    let picked: boolean | undefined;
    runtime.endSessionsWhere.mockImplementation(async (belongs) => {
      picked = belongs({ sessionId: 'elsewhere', cwd: '/tmp/x' });
      return [];
    });
    await withRuntimes.pause(SCOUT.id, PERSON);
    expect(picked).toBe(true);
  });

  it('stops a turn a pause caught still launching, at its first event', async () => {
    const runtime = fakeRuntime();
    let launched!: () => void;
    const launching = new Promise<void>((resolve) => (launched = resolve));
    runtime.sendMessage.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      // The runtime is still signing in: nothing to interrupt yet.
      await launching;
      yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
      yield { type: 'text_delta', data: { text: 'still working' } } as StreamEvent;
    });
    runtime.interruptQuery.mockResolvedValue({ outcome: 'not-running', reason: 'no-open-turn' });
    const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
    const turn = wrapped.sendMessage('s-launch', 'go', { cwd: SCOUT.home });
    const first = turn.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await service.pause(SCOUT.id, PERSON);
    expect(result.stoppedTurns).toBe(0);
    launched();

    await expect(first).rejects.toBeInstanceOf(AgentPausedError);
    expect(runtime.endSessionsWhere).toHaveBeenCalled();
    expect(runtime.endSessionsWhere.mock.calls.at(-1)![0]({ sessionId: 's-launch', cwd: '' })).toBe(
      true
    );
  });

  it('leaves a session another agent ran in this agent’s folder alone', async () => {
    const runtime = fakeRuntime();
    const withRuntimes = new AgentPauseService({ db, runtimes: () => [runtime] });
    initAgentPause(withRuntimes);
    const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
    const turn = wrapped.sendMessage('ana-here', 'go', { cwd: ANA.home });
    await turn.next();
    await turn.return(undefined);
    let picked: boolean | undefined;
    runtime.endSessionsWhere.mockImplementation(async (belongs) => {
      picked = belongs({ sessionId: 'ana-here', cwd: SCOUT.home });
      return [];
    });
    await withRuntimes.pause(SCOUT.id, PERSON);
    expect(picked).toBe(false);
  });

  it("leaves another agent's live turn alone", async () => {
    const runtime = fakeRuntime();
    const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
    const turn = wrapped.sendMessage('s2', 'go', { cwd: ANA.home });
    const drained = (async () => {
      for await (const _event of turn) {
        // drain
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.pause(SCOUT.id, PERSON);
    expect(runtime.interruptQuery).not.toHaveBeenCalled();
    await runtime.interruptQuery();
    await drained;
  });

  it('stops the agent’s running scheduled runs', async () => {
    const stop = vi.fn(async () => 2);
    service.setTaskRunStopper(stop);
    const result = await service.pause(SCOUT.id, PERSON);
    expect(stop).toHaveBeenCalledWith(SCOUT.id);
    expect(result.stoppedRuns).toBe(2);
  });

  it('survives a restart: a new service over the same database is still paused', async () => {
    await service.pause(SCOUT.id, ANA_ACTOR, 'loop');
    const restarted = new AgentPauseService({ db });
    expect(restarted.isPaused(SCOUT.id)).toMatchObject({
      agentId: SCOUT.id,
      pausedBy: ANA_ACTOR,
      reason: 'loop',
    });
  });

  it('lets another agent resume it, and names that agent', async () => {
    await service.pause(SCOUT.id, PERSON);
    const result = service.resume(SCOUT.id, ANA_ACTOR, 'checked, it is fine');
    expect(result).toMatchObject({ paused: false, changed: true });
    expect(service.isPaused(SCOUT.id)).toBeUndefined();
    expect(rows(db).at(-1)).toMatchObject({
      action: 'agent.resumed',
      actorId: ANA.id,
      outcome: 'ok',
      targetId: SCOUT.id,
    });
  });

  it('refuses the paused agent lifting its own pause, and records the refusal', async () => {
    await service.pause(SCOUT.id, PERSON);
    expect(() => service.resume(SCOUT.id, SCOUT_ACTOR)).toThrow(CannotResumeSelfError);
    expect(service.isPaused(SCOUT.id)).toBeDefined();
    expect(rows(db).at(-1)).toMatchObject({
      action: 'agent.resumed',
      actorId: SCOUT.id,
      outcome: 'refused',
      error: 'CANNOT_RESUME_SELF',
    });
  });

  it('refuses a caller it cannot name, which could be the paused agent', async () => {
    await service.pause(SCOUT.id, PERSON);
    const unidentified: AuditActor = { accountId: 'unidentified', kind: 'external', name: 'x' };
    expect(() => service.resume(SCOUT.id, unidentified)).toThrow(CannotResumeSelfError);
    expect(service.isPaused(SCOUT.id)).toBeDefined();
  });

  it('lets an agent pause itself', async () => {
    await expect(service.pause(SCOUT.id, SCOUT_ACTOR)).resolves.toMatchObject({ paused: true });
  });

  it('refuses an id nobody is registered under', async () => {
    await expect(service.pause('nobody', PERSON)).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
  });

  describe('the hold at the runtime seam', () => {
    it('refuses a paused agent’s turn before the runtime is asked, and records it', async () => {
      await service.pause(SCOUT.id, PERSON);
      const runtime = fakeRuntime();
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      const turn = wrapped.sendMessage('s3', 'go', { cwd: SCOUT.home } as MessageOpts);
      await expect(turn.next()).rejects.toBeInstanceOf(AgentPausedError);
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(rows(db).at(-1)).toMatchObject({
        action: 'agent.turn_held',
        actorId: 'system',
        outcome: 'refused',
        targetId: SCOUT.id,
        error: 'AGENT_PAUSED',
      });
    });

    it('holds a turn dispatched AS the agent from a folder that is not its home', async () => {
      await service.pause(SCOUT.id, PERSON);
      const runtime = fakeRuntime();
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      const turn = wrapped.sendMessage('s4', 'go', { forAgent: SCOUT.home });
      await expect(turn.next()).rejects.toMatchObject({ code: 'AGENT_PAUSED' });
    });

    it('refuses a turn with no folder of its own, by the folder its session is stored in', async () => {
      await service.pause(SCOUT.id, PERSON);
      const runtime = fakeRuntime();
      runtime.getSessionCwd.mockReturnValue(SCOUT.home);
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      await expect(wrapped.sendMessage('s7', 'go').next()).rejects.toBeInstanceOf(AgentPausedError);
      expect(runtime.getSessionCwd).toHaveBeenCalledWith('s7');
      expect(runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses a summary (compaction) for a paused agent', async () => {
      await service.pause(SCOUT.id, PERSON);
      const runtime = fakeRuntime();
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      const summary = wrapped.executeCommandIntent('s8', 'compact', { cwd: SCOUT.home });
      await expect(summary.next()).rejects.toBeInstanceOf(AgentPausedError);
      expect(runtime.executeCommandIntent).not.toHaveBeenCalled();
    });

    it('refuses a steer and a stage for a paused agent, so neither boots its process', async () => {
      await service.pause(SCOUT.id, PERSON);
      const runtime = fakeRuntime();
      runtime.getSessionCwd.mockReturnValue(SCOUT.home);
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      await expect(
        wrapped.deliverIntoTurn!('s9', 'also this', { mode: 'steer', messageId: 'm1' })
      ).resolves.toEqual({ delivered: false, reason: 'stream-closed' });
      expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();
      await expect(
        wrapped.deliverIntoTurn!('s9', 'note', { mode: 'stage', messageId: 'm2' })
      ).resolves.toEqual({ delivered: false, reason: 'unsupported' });
      expect(runtime.deliverIntoTurn).not.toHaveBeenCalled();
      (runtime as unknown as { canStageSession: () => boolean }).canStageSession = () => true;
      expect(wrapped.canStageSession!('s9')).toBe(false);
    });

    it('stops a turn the agent starts on its own, ends its session, and records it', async () => {
      const runtime = fakeRuntime();
      runtime.getSessionCwd.mockReturnValue(SCOUT.home);
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      const projected: Array<Promise<StreamEvent[]>> = [];
      wrapped.onRuntimeTurn!((_sessionId, events) => projected.push(drain(events)));
      await service.pause(SCOUT.id, PERSON);

      async function* wake(): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'the helper finished' } } as StreamEvent;
      }
      runtime.emitRuntimeTurn('s10', wake());
      await projected[0];
      await vi.waitFor(() => expect(runtime.endSessionsWhere).toHaveBeenCalledTimes(1));

      expect(runtime.interruptQuery).toHaveBeenCalledWith('s10');
      const belongs = runtime.endSessionsWhere.mock.calls[0]![0];
      expect(belongs({ sessionId: 's10', cwd: SCOUT.home })).toBe(true);
      expect(belongs({ sessionId: 'other', cwd: SCOUT.home })).toBe(false);
      expect(rows(db).at(-1)).toMatchObject({
        action: 'agent.turn_held',
        targetId: SCOUT.id,
        error: 'AGENT_PAUSED',
      });
    });

    it('lets an unpaused agent’s own turn through untouched, and a pause can stop it', async () => {
      const runtime = fakeRuntime();
      runtime.getSessionCwd.mockReturnValue(SCOUT.home);
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      let release!: () => void;
      const parked = new Promise<void>((resolve) => (release = resolve));
      async function* wake(): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'picking it back up' } } as StreamEvent;
        await parked;
      }
      let events: AsyncIterable<StreamEvent> | undefined;
      wrapped.onRuntimeTurn!((_sessionId, turnEvents) => (events = turnEvents));
      runtime.emitRuntimeTurn('s11', wake());
      const iterator = events![Symbol.asyncIterator]();
      await iterator.next();
      runtime.interruptQuery.mockImplementationOnce(async () => {
        release();
        return { outcome: 'acked', runtime: 'claude-code' };
      });
      const result = await service.pause(SCOUT.id, PERSON);
      expect(runtime.interruptQuery).toHaveBeenCalledWith('s11');
      expect(result.stoppedTurns).toBe(1);
      await iterator.return?.();
    });

    it('runs every other agent’s turn as before', async () => {
      await service.pause(SCOUT.id, PERSON);
      const runtime = {
        type: 'claude-code',
        sendMessage: async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'text_delta', data: { text: 'hi' } } as StreamEvent;
        },
        interruptQuery: async () => ({ status: 'not-running' }),
      };
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      const events: StreamEvent[] = [];
      for await (const event of wrapped.sendMessage('s5', 'go', { cwd: ANA.home })) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
    });

    it('starts turns again once the pause is lifted, replaying nothing', async () => {
      await service.pause(SCOUT.id, PERSON);
      service.resume(SCOUT.id, ANA_ACTOR);
      const runtime = fakeRuntime();
      const wrapped = decorateRuntime(runtime as unknown as AgentRuntime, () => null);
      const turn = wrapped.sendMessage('s6', 'go', { cwd: SCOUT.home });
      await expect(turn.next()).resolves.toMatchObject({ done: false });
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
      await turn.return(undefined);
    });
  });
});
