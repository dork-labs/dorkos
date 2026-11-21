import { afterEach, describe, expect, it, vi } from 'vitest';
import { levelOfMode } from '@dorkos/shared/permission-semantics';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RuntimeToolTurnFacts } from '../../../../connectors/runtime-principal-port.js';
import { RuntimeToolContextUnavailableError } from '../../../../connectors/runtime-principal-port.js';
import { isFullLevel } from '../../../../core/turn-power/full-autonomy.js';
import { ApprovalService, hashApprovalInput } from '../../../../core/approvals/index.js';
import { awaitCapabilityApproval } from '../../../../core/capabilities/capability-approval-hold.js';
import { SessionEventStore } from '../../../../session/session-event-store.js';
import { SessionStateProjector } from '../../../../session/session-state-projector.js';
import { feedProjector } from '../../../../session/session-event-normalizer.js';
import { OPENCODE_CAPABILITIES } from '../../runtime-constants.js';
import { OpenCodeMcpManager } from '../../mcp/mcp-manager.js';
import {
  permissionAsked,
  permissionRequest,
  sessionIdle,
  statusEvent,
  assistantMessage,
  messageUpdated,
  partUpdated,
  textPart,
  taskToolPart,
  taskToolInput,
  taskToolMetadata,
  toolStateRunning,
  toolPart,
} from '../opencode-sse-fixtures.js';
import { toolTurnFixture } from './fixture.js';

const fixtures: Awaited<ReturnType<typeof toolTurnFixture>>[] = [];
async function fixture() {
  const f = await toolTurnFixture();
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
async function ask(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  f.sidecar.emit(
    permissionAsked(
      permissionRequest(await f.nativeId(), {
        id,
        permission: 'bash',
        metadata: { command: 'printf owned' },
      })
    )
  );
}
function hold(
  f: Awaited<ReturnType<typeof fixture>>,
  facts: RuntimeToolTurnFacts,
  subject?: string
) {
  const approvals = new ApprovalService(f.db);
  const ticket = approvals.request({
    capabilityId: 'test.destroy',
    inputHash: hashApprovalInput({ owned: true, ...(subject ? { subject } : {}) }),
    summary: 'Owned approval',
    requestingSession: { sessionId: 's1', cwd: f.desk },
  });
  const held = awaitCapabilityApproval(
    { approvals, session: facts.session, signal: facts.signal },
    {
      status: 'approval_required',
      capabilityId: 'test.destroy',
      capabilityTitle: 'Owned approval',
      tier: 'destructive',
      approvalId: ticket.approvalId,
      approvalToken: ticket.token,
      expiresAt: ticket.expiresAt,
      reason: 'no_approval',
      message: 'Approval required.',
      retry: { channel: 'mcp-argument', field: 'approvalToken', instructions: 'Retry.' },
    }
  );
  return { approvals, ticket, held };
}

describe('OpenCode current tool turn', () => {
  it('reads live PATCH policy for the native next ask before the real save callback returns', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const run = await f.start();
    const caller = await f.caller();
    expect(caller).toMatchObject({
      runtime: 'opencode',
      sessionId: 's1',
      agentHome: f.home,
      workingDirectory: f.desk,
    });
    expect(f.home).not.toBe(f.desk);
    const original = caller.read();
    expect(original).toMatchObject({
      effectiveMode: 'default',
      chosenMode: 'default',
      neverAsks: false,
    });
    await ask(f, 'first');
    await vi.waitFor(() =>
      expect(run.events.filter((e) => e.type === 'approval_required')).toHaveLength(1)
    );
    const saved = deferred();
    const release = deferred();
    const actualSave = f.sessions.saveSessionSettings.bind(f.sessions);
    // Real SQLite save completes; hold only its return acknowledgement, never invent a store result.
    const save = vi.spyOn(f.sessions, 'saveSessionSettings').mockImplementation(async (...args) => {
      await actualSave(...args);
      saved.release();
      await release.promise;
    });
    let settled = false;
    const patch = f.runtime
      .updateSession('s1', { permissionMode: 'bypassPermissions' })
      .then(() => {
        settled = true;
      });
    try {
      await saved.promise;
      expect(settled).toBe(false);
      expect(caller.read()).toMatchObject({
        effectiveMode: 'bypassPermissions',
        chosenMode: 'bypassPermissions',
      });
      expect(caller.read().session).toBe(original.session);
      expect(caller.read().signal).toBe(original.signal);
      await ask(f, 'second');
      await vi.waitFor(() =>
        expect(f.sidecar.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
          expect.objectContaining({
            path: { id: expect.any(String), permissionID: 'second' },
            body: { response: 'once' },
          })
        )
      );
      expect(settled).toBe(false);
      expect(run.events.filter((e) => e.type === 'approval_required')).toHaveLength(1);
    } finally {
      release.release();
      await patch;
      save.mockRestore();
    }
    await f.runtime.updateSession('s1', { permissionMode: 'default' });
    expect(caller.read().effectiveMode).toBe('default');
    await ask(f, 'third');
    await vi.waitFor(() =>
      expect(run.events.filter((e) => e.type === 'approval_required')).toHaveLength(2)
    );
    await f.finish();
    await run.finished;
  });

  it.each([
    { label: 'person', ceiling: { asks: 'always', reach: 'read' } as const, full: false },
    {
      label: 'marked',
      ceiling: { asks: 'always', reach: 'read', outsider: true } as const,
      full: true,
    },
  ])(
    'keeps $label Read distinct while native approvals obey the same active ceiling',
    async ({ ceiling, full }) => {
      const f = await fixture();
      f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'bypassPermissions' });
      const run = await f.start({ permissionCeiling: ceiling });
      const caller = await f.caller();
      expect(caller.read().effectiveMode).toBe('default');
      expect(
        isFullLevel(levelOfMode(OPENCODE_CAPABILITIES.permissionModes, caller.read().chosenMode))
      ).toBe(full);
      await ask(f, 'bounded');
      await vi.waitFor(() =>
        expect(run.events.some((e) => e.type === 'approval_required')).toBe(true)
      );
      expect(f.sidecar.client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
      await f.finish();
      await run.finished;
    }
  );

  it('keeps the DOR-2515 prepared managed-Full override distinct from actual native Default', async () => {
    const managed = vi.spyOn(OpenCodeMcpManager.prototype, 'ensureManaged');
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const run = await f.start({ permissionMode: 'bypassPermissions' });
    expect(managed.mock.calls.at(-1)![4]).toBe(true);
    expect((await f.caller()).read()).toMatchObject({
      effectiveMode: 'default',
      chosenMode: 'default',
    });
    await ask(f, 'override-gap');
    await vi.waitFor(() =>
      expect(run.events.some((e) => e.type === 'approval_required')).toBe(true)
    );
    expect(f.sidecar.client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
    // Existing DOR-2515: requested settings persist, but the current native gate is still Default.
    expect((await f.sessions.getSessionSettings('s1'))?.permissionMode).toBe('bypassPermissions');
    await f.finish();
    await run.finished;
  });

  it('delivers a real held request and answer through the parked original stream into SQLite record once', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const store = new SessionEventStore(f.db);
    const projector = new SessionStateProjector('s1');
    projector.enablePersistence(store, 'record');
    const events: StreamEvent[] = [];
    const stream = f.makeStream();
    const finished = feedProjector(
      projector,
      (async function* () {
        for await (const event of stream) {
          events.push(event);
          yield event;
        }
      })()
    );
    const run = { events, finished };
    await vi.waitFor(() => expect(f.sidecar.client.session.promptAsync).toHaveBeenCalled());
    const facts = (await f.caller()).read();
    const pending = hold(f, facts);
    await vi.waitFor(() =>
      expect(
        store.readAll('s1').filter((e) => e.type === 'capability_approval_required')
      ).toHaveLength(1)
    );
    expect(run.events.filter((e) => e.type === 'capability_approval_required')).toHaveLength(1);
    expect(run.events.some((e) => e.type === 'done')).toBe(false);
    pending.approvals.grant(pending.ticket.approvalId);
    await expect(pending.held).resolves.toBe('granted');
    await vi.waitFor(() =>
      expect(
        store.readAll('s1').filter((e) => e.type === 'capability_approval_resolved')
      ).toHaveLength(1)
    );
    await f.finish();
    await run.finished;
    const rows = store.readAll('s1');
    expect(rows.filter((e) => e.type === 'capability_approval_required')).toHaveLength(1);
    expect(rows.filter((e) => e.type === 'capability_approval_resolved')).toHaveLength(1);
    expect(rows.filter((e) => e.type === 'capability_approval_required')).toMatchObject([
      { approval: { approvalId: pending.ticket.approvalId } },
    ]);
    expect(rows.filter((e) => e.type === 'capability_approval_resolved')).toMatchObject([
      { approvalId: pending.ticket.approvalId, outcome: 'granted' },
    ]);
    expect(run.events.filter((e) => e.type === 'capability_approval_required')).toMatchObject([
      { data: { approval: { approvalId: pending.ticket.approvalId } } },
    ]);
    expect(run.events.filter((e) => e.type === 'capability_approval_resolved')).toMatchObject([
      { data: { approvalId: pending.ticket.approvalId, outcome: 'granted' } },
    ]);
    expect(new Set(rows.map((e) => e.seq)).size).toBe(rows.length);
    expect(store.readAll(await f.nativeId())).toEqual([]);
    expect(store.readAll('successor')).toEqual([]);
    expect(facts.session.eventQueue).toEqual([]);
  });

  it('keeps own status-idle and positively admitted child idle alive for the next native ask', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const run = await f.start();
    const caller = await f.caller();
    const facts = caller.read();
    const id = await f.nativeId();
    f.sidecar.emit(messageUpdated(assistantMessage(id)));
    f.sidecar.emit(
      partUpdated(
        taskToolPart(
          id,
          'owned-task',
          toolStateRunning(taskToolInput()),
          taskToolMetadata('ses_owned_child', id)
        )
      )
    );
    await vi.waitFor(() =>
      expect(run.events.some((e) => e.type === 'background_task_started')).toBe(true)
    );
    f.sidecar.emit(
      partUpdated(
        toolPart('ses_owned_child', 'child-tool', 'read', toolStateRunning({ filePath: 'owned' }))
      )
    );
    await vi.waitFor(() =>
      expect(run.events.some((e) => e.type === 'background_task_progress')).toBe(true)
    );
    f.sidecar.emit(sessionIdle('ses_owned_child'));
    f.sidecar.emit(statusEvent(id, { type: 'idle' }));
    await ask(f, 'after-nonterminal-idle');
    await vi.waitFor(() =>
      expect(run.events.some((e) => e.type === 'approval_required')).toBe(true)
    );
    expect(facts.signal.aborted).toBe(false);
    expect(caller.read().session).toBe(facts.session);
    await f.finish();
    await run.finished;
    expect(facts.signal.aborted).toBe(true);
  });

  it('does not trust vendor JSON host-like tags to bypass the native approval pipeline', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const run = await f.start();
    const event = permissionAsked(
      permissionRequest(await f.nativeId(), {
        id: 'vendor-tag',
        permission: 'bash',
        metadata: { command: 'printf owned' },
      })
    );
    // A vendor can supply JSON keys, never the private server symbol.
    const vendorEvent = { ...event, hostEvent: true, __host: true };
    f.sidecar.emit(vendorEvent);
    await vi.waitFor(() =>
      expect(run.events.filter((e) => e.type === 'approval_required')).toHaveLength(1)
    );
    expect(run.events.filter((e) => e.type === 'capability_approval_required')).toEqual([]);
    expect(f.sidecar.client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
    expect(f.runtime.approveTool('s1', 'vendor-tag', true)).toBe(true);
    await vi.waitFor(() =>
      expect(f.sidecar.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
        expect.objectContaining({ body: { response: 'once' } })
      )
    );
    await f.finish();
    await run.finished;
  });

  it('denies a replaced registered home and admits the new actual owner on a later turn', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const run = await f.start();
    const old = await f.caller();
    const registered = f.mesh.getByPath(f.home)!;
    await f.mesh.unregister(registered.id);
    await f.mesh.registerByPath(f.home, {
      name: 'Replacement owner',
      runtime: 'opencode',
      capabilities: [],
    });
    await expect(old.assertCurrent()).rejects.toThrow();
    await f.finish();
    await run.finished;
    const successor = await f.start();
    const current = await f.caller();
    expect(current.agentHome).toBe(f.home);
    expect(current.sessionId).toBe('s1');
    expect(current.read().effectiveMode).toBe('default');
    await expect(current.assertCurrent()).resolves.toBeUndefined();
    await expect(old.assertCurrent()).rejects.toThrow();
    await f.finish();
    await successor.finished;
  });

  it('keeps setup unavailable until actual registration completes and retires an interrupted owner', async () => {
    const entered = deferred();
    const release = deferred();
    const actual = OpenCodeMcpManager.prototype.ensureManaged;
    const gate = vi
      .spyOn(OpenCodeMcpManager.prototype, 'ensureManaged')
      .mockImplementation(async function (this: OpenCodeMcpManager, ...args) {
        entered.release();
        await release.promise;
        return actual.apply(this, args);
      });
    const f = await fixture();
    const starting = f.start();
    await entered.promise;
    try {
      expect(f.opens.mock.calls[0]![1].readToolTurn!()).toBeUndefined();
      await expect(f.caller()).rejects.toThrow(RuntimeToolContextUnavailableError);
      expect(f.sidecar.client.session.promptAsync).not.toHaveBeenCalled();
    } finally {
      release.release();
    }
    const run = await starting;
    gate.mockRestore();
    const old = await f.caller();
    const facts = old.read();
    const interrupted = f.runtime.interruptQuery('s1');
    expect(facts.signal.aborted).toBe(true);
    await run.finished;
    await interrupted;
    await expect(old.assertCurrent()).rejects.toThrow();
    const next = await f.start();
    const current = await f.caller();
    expect(current.read().signal.aborted).toBe(false);
    expect(current.read().session).not.toBe(facts.session);
    await f.finish();
    await next.finished;
  });

  it('publishes live tool facts when the prompt starts after subscription readiness', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const requested = deferred();
    const ready = deferred();
    const connect = f.sidecar.client.global.event.getMockImplementation();
    if (!connect) throw new Error('Missing scripted event stream');
    f.sidecar.client.global.event.mockImplementationOnce(async (options) => {
      requested.release();
      await ready.promise;
      return connect(options);
    });

    const starting = f.start();
    try {
      await Promise.race([
        requested.promise,
        starting.then(() => {
          throw new Error('Prompt started before the event subscription was ready');
        }),
      ]);
      expect(f.sidecar.client.session.promptAsync).not.toHaveBeenCalled();
      expect(f.opens.mock.calls[0]![1].readToolTurn!()).toBeUndefined();
    } finally {
      ready.release();
    }

    const run = await starting;
    expect(f.sidecar.client.session.promptAsync).toHaveBeenCalledOnce();
    const caller = await f.caller();
    expect(caller).toMatchObject({ sessionId: 's1', agentHome: f.home, workingDirectory: f.desk });
    expect(caller.read()).toMatchObject({ effectiveMode: 'default', chosenMode: 'default' });
    await f.finish();
    await run.finished;
  });

  it('publishes facts after native prompt preparation and retires them when dispatch fails', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const preparing = deferred();
    const prepared = deferred();
    f.sidecar.client.app.agents.mockImplementationOnce(async () => {
      preparing.release();
      await prepared.promise;
      return { data: [] };
    });
    const promptFailure = new Error('Scripted native prompt failure');
    let atPrompt: RuntimeToolTurnFacts | undefined;
    const readToolTurn = () => f.opens.mock.calls[0]?.[1].readToolTurn?.();
    const { promptAsync } = f.sidecar.client.session;
    promptAsync.mockImplementationOnce(async () => {
      atPrompt = readToolTurn();
      throw promptFailure;
    });

    const stream = f.makeStream();
    const result = (async () => {
      for await (const _event of stream) {
        // Consume the ordinary generator so failures reach its existing teardown.
      }
    })().catch((error: unknown) => error);
    try {
      await Promise.race([
        preparing.promise,
        result.then(() => {
          throw new Error('Turn did not reach its native preparation read');
        }),
      ]);
      expect(promptAsync).not.toHaveBeenCalled();
      expect(readToolTurn()).toBeUndefined();
      await expect(f.caller()).rejects.toThrow(RuntimeToolContextUnavailableError);
    } finally {
      prepared.release();
      await result;
    }

    expect(await result).toBe(promptFailure);
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(atPrompt).toMatchObject({ effectiveMode: 'default', chosenMode: 'default' });
    expect(atPrompt?.signal.aborted).toBe(true);
    expect(readToolTurn()).toBeUndefined();
  });

  it('aborts a cached real hold at own native idle before the paused consumer drains, retaining its queued request', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const stream = f.makeStream();
    const paused = (async () => {
      for (;;) {
        const next = await stream.next();
        if (next.done) throw new Error('Ended before text');
        if (next.value.type === 'text_delta') return;
      }
    })();
    await vi.waitFor(() => expect(f.sidecar.client.session.promptAsync).toHaveBeenCalled());
    const id = await f.nativeId();
    f.sidecar.emit(messageUpdated(assistantMessage(id)));
    f.sidecar.emit(partUpdated(textPart(id, 'part_text', 'parked')));
    await paused;
    const caller = await f.caller();
    const facts = caller.read();
    const pending = hold(f, facts);
    expect(pending.approvals.claimVerdictDelivery(pending.ticket.approvalId)).toBe(false);
    f.sidecar.emit(sessionIdle(id));
    await new Promise<void>((r) => setImmediate(r));
    expect(f.opens.mock.calls[0]![1].isCurrent()).toBe(true);
    expect(f.opens.mock.calls[0]![0].signal.aborted).toBe(false);
    expect(facts.signal.aborted).toBe(true);
    await expect(pending.held).resolves.toBe('timeout');
    expect(pending.approvals.claimVerdictDelivery(pending.ticket.approvalId)).toBe(true);
    pending.approvals.releaseVerdictDelivery(pending.ticket.approvalId);
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    const effects: string[] = [];
    try {
      await caller.assertCurrent();
      caller.read();
      effects.push('late');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeToolContextUnavailableError);
    }
    expect(effects).toEqual([]);
    facts.session.eventQueue.push({ type: 'text_delta', data: { text: 'late-card' } });
    facts.session.eventQueueNotify!();
    const remaining: StreamEvent[] = [];
    for await (const event of stream) remaining.push(event);
    expect(remaining.filter((e) => e.type === 'capability_approval_required')).toHaveLength(1);
    expect(remaining.some((e) => e.type === 'text_delta')).toBe(false);
    expect(remaining.filter((e) => e.type === 'done')).toHaveLength(1);
    const successor = await f.start();
    const current = await f.caller();
    const currentFacts = current.read();
    expect(currentFacts.signal.aborted).toBe(false);
    expect(currentFacts.session).not.toBe(facts.session);
    await expect(current.assertCurrent()).resolves.toBeUndefined();
    const currentHold = hold(f, currentFacts, 'successor');
    expect(currentHold.ticket.approvalId).not.toBe(pending.ticket.approvalId);
    await vi.waitFor(() =>
      expect(
        successor.events.filter((e) => e.type === 'capability_approval_required')
      ).toMatchObject([{ data: { approval: { approvalId: currentHold.ticket.approvalId } } }])
    );
    const oldCard = remaining.find((e) => e.type === 'capability_approval_required')!;
    facts.session.eventQueue.push(
      { type: 'text_delta', data: { text: 'old-into-successor' } },
      oldCard
    );
    facts.session.eventQueueNotify!();
    await expect(async () => {
      await caller.assertCurrent();
      caller.read();
      effects.push('old-into-successor');
    }).rejects.toThrow();
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    currentHold.approvals.grant(currentHold.ticket.approvalId);
    await expect(currentHold.held).resolves.toBe('granted');
    await vi.waitFor(() =>
      expect(
        successor.events.filter((e) => e.type === 'capability_approval_resolved')
      ).toMatchObject([{ data: { approvalId: currentHold.ticket.approvalId, outcome: 'granted' } }])
    );
    expect(successor.events.filter((e) => e.type === 'capability_approval_required')).toHaveLength(
      1
    );
    expect(successor.events.filter((e) => e.type === 'text_delta')).toEqual([]);
    expect(effects).toEqual([]);
    await f.finish();
    await successor.finished;
  });
});
