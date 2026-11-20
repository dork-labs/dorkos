import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { toolTurnFixture } from './fixture.js';
import { RuntimeToolContextUnavailableError } from '../../../../connectors/runtime-principal-port.js';
import { feedProjector } from '../../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../../session/session-state-projector.js';
import { SessionEventStore } from '../../../../session/session-event-store.js';
import { ApprovalService, hashApprovalInput } from '../../../../core/approvals/index.js';
import { awaitCapabilityApproval } from '../../../../core/capabilities/capability-approval-hold.js';
import { CODEX_CAPABILITIES } from '../../runtime-constants.js';
import { levelOfMode } from '@dorkos/shared/permission-semantics';
import { isFullLevel } from '../../../../core/turn-power/full-autonomy.js';
import type { RuntimeToolTurnFacts } from '../../../../connectors/runtime-principal-port.js';
import { approvalPolicyFor } from '../../app-server/turn-parts.js';
import { backgroundCommandTurn } from '../fake-app-server.js';
import type { FakeTurnContext } from '../fake-app-server.js';

const fixtures: Awaited<ReturnType<typeof toolTurnFixture>>[] = [];
async function fixture(failBinary = false) {
  const f = await toolTurnFixture(failBinary);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  vi.restoreAllMocks();
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

// Native process/model execution is the only scripted boundary: the runtime and wire are real.
describe('Codex current tool turn', () => {
  it('keeps pending Full out of prepared facts and applies it only to the next turn', async () => {
    const f = await fixture();
    const entered = deferred();
    const end = deferred();
    let ctx!: FakeTurnContext;
    f.server.nextTurn(async (c) => {
      ctx = c;
      c.agentMessage('working');
      entered.release();
      await end.promise;
      c.complete();
    });
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default', model: 'fixed-model' });
    const events: StreamEvent[] = [];
    const run = (async () => {
      for await (const e of f.runtime.sendMessage('s1', 'hello', { cwd: f.desk, forAgent: f.home }))
        events.push(e);
    })();
    try {
      await Promise.race([
        entered.promise,
        run.then(() => {
          throw new Error('Turn ended before scripted entry');
        }),
      ]);
      const caller = await f.caller();
      expect(caller).toMatchObject({
        runtime: 'codex',
        sessionId: 's1',
        agentHome: f.home,
        workingDirectory: f.desk,
      });
      expect(f.desk).not.toBe(f.home);
      expect(ctx.params).toMatchObject({ model: 'fixed-model' });
      expect(caller.read()).toMatchObject({
        effectiveMode: 'default',
        chosenMode: 'default',
        neverAsks: false,
      });
      await f.runtime.updateSession('s1', { permissionMode: 'bypassPermissions' });
      expect(caller.read()).toMatchObject({ effectiveMode: 'default', chosenMode: 'default' });
      const binding = await f.opens.mock.results[0]!.value;
      await expect(
        f.service.renew({ bindingId: binding.bindingId, permit: binding.renewalPermit })
      ).resolves.toMatchObject({ status: 'renewed' });
      expect(caller.read().effectiveMode).toBe('default');
      end.release();
      await run;
      expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
      f.server.nextTurn(async (c) => {
        c.agentMessage('second');
        const next = await f.caller();
        expect(next.read()).toMatchObject({
          effectiveMode: 'bypassPermissions',
          chosenMode: 'bypassPermissions',
        });
        c.complete();
      });
      for await (const _ of f.runtime.sendMessage('s1', 'again', {
        cwd: f.desk,
        forAgent: f.home,
      })) {
        /* drain */
      }
      expect(f.opens).toHaveBeenCalledTimes(2);
    } finally {
      end.release();
      await run;
    }
  });

  it.each([
    { label: 'person', ceiling: { asks: 'always', reach: 'read' } as const, full: false },
    {
      label: 'marked',
      ceiling: { asks: 'always', reach: 'read', outsider: true } as const,
      full: true,
    },
  ])('keeps $label Read bounds distinct from chosen Full', async ({ ceiling, full }) => {
    const f = await fixture();
    let facts: RuntimeToolTurnFacts | undefined;
    f.server.nextTurn(async (c) => {
      facts = (await f.caller()).read();
      c.complete();
    });
    f.runtime.ensureSession('s1', { cwd: f.home, permissionMode: 'bypassPermissions' });
    for await (const _ of f.runtime.sendMessage('s1', 'bounded', {
      cwd: f.home,
      permissionCeiling: ceiling,
    })) {
      /* drain */
    }
    expect(facts).toMatchObject({ effectiveMode: 'default', neverAsks: false });
    expect(isFullLevel(levelOfMode(CODEX_CAPABILITIES.permissionModes, facts?.chosenMode))).toBe(
      full
    );
  });

  it('retires facts at native terminal before a paused consumer drains done', async () => {
    const f = await fixture();
    const started = deferred();
    let ctx!: FakeTurnContext;
    f.server.nextTurn((c) => {
      ctx = c;
      c.agentMessage('one');
      started.release();
    });
    f.runtime.ensureSession('s1', { cwd: f.home, permissionMode: 'default' });
    const stream = f.runtime.sendMessage('s1', 'hello', { cwd: f.home });
    // Pause the real consumer on a nonterminal item; the native mapper can still end.
    for (;;) {
      const next = await stream.next();
      expect(next.done).toBe(false);
      if (next.value.type === 'text_delta') break;
    }
    await started.promise;
    const caller = await f.caller();
    const facts = caller.read();
    const approvals = new ApprovalService(f.db);
    const ticket = approvals.request({
      capabilityId: 'test.destroy',
      inputHash: hashApprovalInput({ owned: true }),
      summary: 'Owned terminal hold',
      requestingSession: { sessionId: 's1', cwd: f.home },
    });
    const held = awaitCapabilityApproval(
      { approvals, session: facts.session, signal: facts.signal },
      {
        status: 'approval_required',
        capabilityId: 'test.destroy',
        capabilityTitle: 'Owned terminal hold',
        tier: 'destructive',
        approvalId: ticket.approvalId,
        approvalToken: ticket.token,
        expiresAt: ticket.expiresAt,
        reason: 'no_approval',
        message: 'Approval required.',
        retry: { channel: 'mcp-argument', field: 'approvalToken', instructions: 'Retry.' },
      }
    );
    expect(approvals.claimVerdictDelivery(ticket.approvalId)).toBe(false);
    ctx.complete();
    await new Promise<void>((r) => setImmediate(r));
    const ownership = f.opens.mock.calls[0]![1];
    expect(ownership.isCurrent()).toBe(true); // Consumer has not reached runtime finally.
    expect(f.opens.mock.calls[0]![0].signal.aborted).toBe(false); // Normal completion is not user cancel.
    expect(facts.signal.aborted).toBe(true);
    await expect(held).resolves.toBe('timeout');
    expect(approvals.claimVerdictDelivery(ticket.approvalId)).toBe(true);
    approvals.releaseVerdictDelivery(ticket.approvalId);
    const lateEffects: string[] = [];
    try {
      await caller.assertCurrent();
      caller.read();
      lateEffects.push('owned-effect');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeToolContextUnavailableError);
    }
    expect(lateEffects).toEqual([]);
    expect(ownership.readToolTurn!()).toBeUndefined();
    facts.session.eventQueue.push({ type: 'text_delta', data: { text: 'late-card' } });
    facts.session.eventQueueNotify!();
    const remaining: StreamEvent[] = [];
    for await (const e of stream) remaining.push(e);
    expect(
      remaining.some(
        (e) => e.type === 'text_delta' && 'text' in e.data && e.data.text === 'late-card'
      )
    ).toBe(false);
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
  });

  it('delivers the actual approval hold through the original stream into SQLite record once', async () => {
    const f = await fixture();
    const entered = deferred();
    const finish = deferred();
    f.server.nextTurn(async (c) => {
      c.agentMessage('waiting');
      entered.release();
      await finish.promise;
      c.complete();
    });
    f.runtime.ensureSession('s1', { cwd: f.home, permissionMode: 'acceptEdits' });
    const projector = new SessionStateProjector('s1');
    const store = new SessionEventStore(f.db);
    projector.enablePersistence(store, 'record');
    const run = feedProjector(projector, f.runtime.sendMessage('s1', 'hold', { cwd: f.home }));
    try {
      await Promise.race([
        entered.promise,
        run.then(() => {
          throw new Error('Turn ended before scripted entry');
        }),
      ]);
      const facts = (await f.caller()).read();
      const approvals = new ApprovalService(f.db);
      const ticket = approvals.request({
        capabilityId: 'test.destroy',
        inputHash: hashApprovalInput({ subject: 'owned' }),
        summary: 'Delete owned fixture',
        requestingSession: { sessionId: 's1', cwd: f.home },
      });
      const payload = {
        status: 'approval_required' as const,
        approvalId: ticket.approvalId,
        approvalToken: ticket.token,
        expiresAt: ticket.expiresAt,
        capabilityId: 'test.destroy',
        capabilityTitle: 'Delete owned fixture',
        tier: 'destructive' as const,
        reason: 'no_approval' as const,
        message: 'Approval required.',
        retry: {
          channel: 'mcp-argument' as const,
          field: 'approvalToken',
          instructions: 'Retry with the token.',
        },
      };
      const hold = awaitCapabilityApproval(
        { approvals, session: facts.session, signal: facts.signal },
        payload
      );
      await vi.waitFor(() => expect(projector.hasPendingInteractions()).toBe(true));
      approvals.grant(ticket.approvalId);
      await expect(hold).resolves.toBe('granted');
      finish.release();
      await run;
      const own = store.readAll('s1');
      expect(own.filter((e) => e.type === 'capability_approval_required')).toHaveLength(1);
      expect(own.filter((e) => e.type === 'capability_approval_resolved')).toHaveLength(1);
      expect(store.readAll('successor')).toEqual([]);
      expect(facts.session.eventQueue).toEqual([]);
    } finally {
      finish.release();
      await run;
    }
  });

  it('resolves the actual loaded thread key only for its current binding, not background ownership', async () => {
    const f = await fixture();
    const bg = backgroundCommandTurn();
    let key = '';
    let oldPrincipal;
    f.server.nextTurn(async (c) => {
      const loaded = c.server.loaded.get(c.turn.threadId)!;
      const config = loaded.loadParams.config as {
        mcp_servers: Record<string, { http_headers: { Authorization: string } }>;
      };
      key = config.mcp_servers.dorkos!.http_headers.Authorization.slice('Bearer '.length);
      const resolved = await f.service.resolve({
        bearer: key,
        expectedRuntime: 'codex',
        expectedCanonicalCwd: f.home,
      });
      expect(resolved.status).toBe('resolved');
      if (resolved.status !== 'resolved') throw new Error('Current thread key must resolve');
      oldPrincipal = resolved.principal;
      expect((await f.service.resolveToolTurn(resolved.principal)).read().effectiveMode).toBe(
        'default'
      );
      await bg.script(c);
    });
    f.runtime.ensureSession('s1', { cwd: f.home, permissionMode: 'default' });
    for await (const _ of f.runtime.sendMessage('s1', 'background', { cwd: f.home })) {
      /* drain */
    }
    expect(f.h.transport.holdsBackgroundWork('s1')).toBe(true);
    expect(f.h.threadKeys.lookup(key)).toMatchObject({ bindingId: undefined });
    await expect(
      f.service.resolve({ bearer: key, expectedRuntime: 'codex', expectedCanonicalCwd: f.home })
    ).resolves.toMatchObject({ status: 'refused', reason: 'expired' });
    expect(oldPrincipal).toBeDefined();
    await expect(f.service.resolveToolTurn(oldPrincipal!)).rejects.toBeInstanceOf(
      RuntimeToolContextUnavailableError
    );
  });

  it('drops held cards on interrupt and never delivers them to the successor', async () => {
    const f = await fixture();
    const entered = deferred();
    const events: StreamEvent[] = [];
    f.server.nextTurn(async (c) => {
      c.agentMessage('parked');
      entered.release();
      await c.turn.interrupted;
      c.complete('interrupted');
    });
    f.runtime.ensureSession('s1', { cwd: f.home, permissionMode: 'default' });
    const run = (async () => {
      for await (const e of f.runtime.sendMessage('s1', 'park', { cwd: f.home })) events.push(e);
    })();
    await Promise.race([
      entered.promise,
      run.then(() => {
        throw new Error('Turn ended before entry');
      }),
    ]);
    const caller = await f.caller();
    const facts = caller.read();
    await f.runtime.interruptQuery('s1');
    await run;
    expect(facts.signal.aborted).toBe(true);
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    facts.session.eventQueue.push({ type: 'text_delta', data: { text: 'orphan' } });
    facts.session.eventQueueNotify!();
    const successor: StreamEvent[] = [];
    f.server.nextTurn(async (c) => {
      const next = await f.caller();
      expect(next.read().signal.aborted).toBe(false);
      c.agentMessage('successor');
      c.complete();
    });
    for await (const e of f.runtime.sendMessage('s1', 'next', { cwd: f.home })) successor.push(e);
    expect(
      successor.some((e) => e.type === 'text_delta' && 'text' in e.data && e.data.text === 'orphan')
    ).toBe(false);
    expect(
      events.some((e) => e.type === 'text_delta' && 'text' in e.data && e.data.text === 'orphan')
    ).toBe(false);
  });

  it('retains no eligible facts or native turn after setup fails following a real binding', async () => {
    const f = await fixture(true);
    f.runtime.ensureSession('s1', { cwd: f.home, permissionMode: 'default' });
    const run = async () => {
      for await (const _ of f.runtime.sendMessage('s1', 'fail', { cwd: f.home })) {
        /* drain */
      }
    };
    await expect(run()).rejects.toThrow('owned setup failure');
    expect(f.opens).toHaveBeenCalledOnce();
    expect(f.opens.mock.calls[0]![1].readToolTurn!()).toBeUndefined();
    const opened = await f.opens.mock.results[0]!.value;
    await expect(
      f.service.resolve({
        bearer: opened.bearer,
        expectedRuntime: 'codex',
        expectedCanonicalCwd: f.home,
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'revoked' });
    expect(f.h.host.spawns).toHaveLength(0);
  });

  it('publishes tool facts when the prepared model starts its turn', async () => {
    const f = await fixture();
    f.server.config = { model: 'old-model', model_provider: 'openai' };
    f.server.modelList = () => ({
      data: [
        {
          model: 'available',
          displayName: 'Available',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: [],
        },
      ],
      nextCursor: null,
    });
    f.runtime.ensureSession('s1', { cwd: f.home, permissionMode: 'default' });
    let facts: RuntimeToolTurnFacts | undefined;
    f.server.nextTurn(async (c) => {
      facts = (await f.caller()).read();
      c.complete();
    });

    let notices = 0;
    for await (const event of f.runtime.sendMessage('s1', 'hello', { cwd: f.home })) {
      if (event.type !== 'model_substituted') continue;
      notices++;
      expect(f.opens).toHaveBeenCalledOnce();
      expect(f.opens.mock.calls[0]![1].readToolTurn!()).toBeUndefined();
      expect(f.server.processes[0]!.requestsOf('turn/start')).toEqual([]);
    }

    expect(notices).toBe(1);
    expect(f.server.processes[0]!.requestsOf('turn/start')).toEqual([
      expect.objectContaining({ model: 'available' }),
    ]);
    expect(facts).toMatchObject({ effectiveMode: 'default', chosenMode: 'default' });
  });

  it('rechecks real registered-agent ownership and permits a newly registered current owner', async () => {
    const f = await fixture();
    const entered = deferred();
    const end = deferred();
    f.server.nextTurn(async (c) => {
      c.agentMessage('owned');
      entered.release();
      await end.promise;
      c.complete();
    });
    f.runtime.ensureSession('s1', { cwd: f.home, permissionMode: 'default' });
    const run = (async () => {
      for await (const _ of f.runtime.sendMessage('s1', 'authority', { cwd: f.home })) {
        /* drain */
      }
    })();
    try {
      await Promise.race([
        entered.promise,
        run.then(() => {
          throw new Error('Turn ended before entry');
        }),
      ]);
      expect(await f.sessions.resolveSessionRuntime('s1')).toMatchObject({
        type: 'codex',
        bound: true,
      });
      expect(await f.sessions.getSessionAgentPath('s1')).toBe(f.home);
      const agent = f.mesh.getByPath(f.home)!;
      expect(agent.id).toBeDefined();
      const caller = await f.caller();
      await expect(caller.assertCurrent()).resolves.toBeUndefined();
      await f.mesh.unregister(agent.id);
      expect(f.mesh.getByPath(f.home)).toBeUndefined();
      await expect(caller.assertCurrent()).rejects.toBeInstanceOf(
        RuntimeToolContextUnavailableError
      );
      expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
      end.release();
      await run;
      const replacement = await f.mesh.registerByPath(f.home, {
        name: 'Current owner',
        runtime: 'codex',
        capabilities: [],
      });
      expect(replacement.id).not.toBe(agent.id);
      f.server.nextTurn(async (c) => {
        const current = await f.caller();
        await expect(current.assertCurrent()).resolves.toBeUndefined();
        expect(current.read().effectiveMode).toBe('default');
        c.complete();
      });
      for await (const _ of f.runtime.sendMessage('s1', 'new owner', { cwd: f.home })) {
        /* drain */
      }
      expect(f.opens).toHaveBeenCalledTimes(2);
    } finally {
      end.release();
      await run;
    }
  });

  it('distinguishes current descriptor asks policy from unsupported person-only Never ask', async () => {
    const descriptors = CODEX_CAPABILITIES.permissionModes.values!;
    expect(descriptors.length).toBeGreaterThan(0);
    // Enumerates actual descriptors: a future person-only/unknown mode needs explicit support.
    for (const mode of descriptors) {
      expect(mode.id).not.toBe('dontAsk');
      expect(approvalPolicyFor({ permissionMode: mode.id })).toBe(
        mode.reach === 'everything' ? 'never' : 'on-request'
      );
    }
  });
});
