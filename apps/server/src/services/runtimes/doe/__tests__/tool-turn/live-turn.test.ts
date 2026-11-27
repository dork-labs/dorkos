import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { StreamEvent } from '@dorkos/shared/types';
import { levelOfMode } from '@dorkos/shared/permission-semantics';
import { isFullLevel } from '../../../../core/turn-power/full-autonomy.js';
import { RuntimeToolContextUnavailableError } from '@dorkos/shared/connections-lease';
import { SessionEventStore } from '../../../../session/session-event-store.js';
import { SessionStateProjector } from '../../../../session/session-state-projector.js';
import { feedProjector } from '../../../../session/session-event-normalizer.js';
import { DOE_CAPABILITIES } from '../../runtime-constants.js';
import { hold, settleHolds } from './approval.js';
import { toolTurnFixture } from './fixture.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fixtures: Awaited<ReturnType<typeof toolTurnFixture>>[] = [];
async function fixture(options?: Parameters<typeof toolTurnFixture>[0]) {
  const f = await toolTurnFixture(options);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  const errors: unknown[] = [];
  try {
    await settleHolds();
  } catch (error) {
    errors.push(error);
  }
  for (const f of fixtures.splice(0)) {
    try {
      await f.close();
    } catch (error) {
      errors.push(error);
    }
  }
  vi.restoreAllMocks();
  if (errors.length) throw new AggregateError(errors, 'Owned test cleanup failed');
});

describe('Doe current tool turn', () => {
  it('keeps actual native Default approval while stored Full is pending, then applies Full on the next turn', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const run = await f.start();
    const caller = await f.caller();
    const original = caller.read();
    expect(original).toMatchObject({ effectiveMode: 'default', chosenMode: 'default' });
    const write = run.native.request.tools.find((tool) => tool.name === 'write')!;
    expect(write).toBeDefined();
    expect(run.native.request.context).toMatchObject({ sessionId: 's1', workingDirectory: f.desk });
    const pending = run.native.request.approve!(
      write,
      { path: path.join(f.desk, 'owned.txt'), content: 'owned' },
      { ...run.native.request.context, callId: 'native-before' }
    );
    const update = await f.runtime.updateSession('s1', { permissionMode: 'bypassPermissions' });
    expect(update).toMatchObject({ permissionModePendingUntilNextTurn: true });
    expect(caller.read().effectiveMode).toBe('default');
    expect(caller.read().chosenMode).toBe('default');
    expect(caller.read().session).toBe(original.session);
    expect(caller.read().signal).toBe(original.signal);
    await vi.waitFor(() =>
      expect(run.events.some((event) => event.type === 'approval_required')).toBe(true)
    );
    expect(f.runtime.approveTool('s1', 'native-before', true)).toBe(true);
    await expect(pending).resolves.toBe('allow');
    const after = run.native.request.approve!(
      write,
      { path: path.join(f.desk, 'owned.txt'), content: 'owned' },
      { ...run.native.request.context, callId: 'native-after' }
    );
    expect(f.runtime.approveTool('s1', 'native-after', false)).toBe(true);
    await expect(after).resolves.toBe('deny');
    run.native.finish();
    await run.finished;
    const next = await f.start();
    expect((await f.caller()).read()).toMatchObject({
      effectiveMode: 'bypassPermissions',
      chosenMode: 'bypassPermissions',
      neverAsks: false,
    });
    const nextWrite = next.native.request.tools.find((tool) => tool.name === 'write')!;
    await expect(
      next.native.request.approve!(
        nextWrite,
        { path: path.join(f.desk, 'owned.txt'), content: 'owned' },
        { ...next.native.request.context, callId: 'native-next' }
      )
    ).resolves.toBe('allow');
    next.native.finish();
    await next.finished;
  });

  it('offers real prepared live facts through the same current ownership once its host is ready', async () => {
    const f = await fixture();
    f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'default' });
    const run = await f.start();
    expect(f.opens.mock.calls[0]![1].readToolTurn).toEqual(expect.any(Function));
    const caller = await f.caller();
    expect(caller).toMatchObject({
      runtime: 'doe',
      sessionId: 's1',
      agentHome: f.home,
      workingDirectory: f.desk,
    });
    expect(f.home).not.toBe(f.desk);
    const memory = run.native.request.tools.find((tool) => tool.name === 'memory_read')!;
    expect(memory).toBeDefined();
    const result = await memory.execute({}, run.native.request.context);
    expect(result.isError).not.toBe(true);
    const block = result.content[0];
    if (
      !block ||
      typeof block !== 'object' ||
      Array.isArray(block) ||
      !('text' in block) ||
      typeof block.text !== 'string'
    )
      throw new Error('Expected actual MCP JSON text');
    expect(JSON.parse(block.text)).toMatchObject({ ok: true, total: 0 });
    expect(caller.read()).toMatchObject({
      effectiveMode: 'default',
      chosenMode: 'default',
      neverAsks: false,
    });
    run.native.finish();
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
    'keeps $label Read distinct while the actual native engine stays clamped',
    async ({ ceiling, full }) => {
      const f = await fixture();
      await f.sessions.saveSessionSettings('s1', { permissionMode: 'bypassPermissions' });
      const run = await f.start({ permissionCeiling: ceiling });
      const caller = await f.caller();
      expect(caller.read().effectiveMode).toBe('default');
      expect(
        isFullLevel(levelOfMode(DOE_CAPABILITIES.permissionModes, caller.read().chosenMode))
      ).toBe(full);
      const write = run.native.request.tools.find((tool) => tool.name === 'write')!;
      const native = run.native.request.approve!(
        write,
        { path: path.join(f.desk, 'bounded.txt'), content: 'owned' },
        { ...run.native.request.context, callId: 'bounded' }
      );
      await vi.waitFor(() =>
        expect(run.events.some((event) => event.type === 'approval_required')).toBe(true)
      );
      expect(f.runtime.approveTool('s1', 'bounded', false)).toBe(true);
      await expect(native).resolves.toBe('deny');
      run.native.finish();
      await run.finished;
    }
  );

  it('wakes the parked original stream and records exactly its real request and granted answer', async () => {
    const f = await fixture();
    const store = new SessionEventStore(f.db),
      projector = new SessionStateProjector('s1');
    projector.enablePersistence(store, 'record');
    const events: StreamEvent[] = [];
    const stream = f.makeStream();
    const feeding = feedProjector(
      projector,
      (async function* () {
        for await (const event of stream) {
          events.push(event);
          yield event;
        }
      })()
    );
    const native = await f.engine.next(0);
    const caller = await f.caller();
    expect(native.request.context.sessionId).toBe(caller.sessionId);
    expect(f.runtime.getInternalSessionId()).toBeUndefined();
    const pending = hold(f, caller.read(), 'record');
    await vi.waitFor(() =>
      expect(
        store.readAll('s1').filter((event) => event.type === 'capability_approval_required')
      ).toMatchObject([{ approval: { approvalId: pending.ticket.approvalId } }])
    );
    expect(events.filter((event) => event.type === 'capability_approval_required')).toMatchObject([
      { data: { approval: { approvalId: pending.ticket.approvalId } } },
    ]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    pending.approvals.grant(pending.ticket.approvalId);
    await expect(pending.held).resolves.toBe('granted');
    await vi.waitFor(() =>
      expect(
        store.readAll('s1').filter((event) => event.type === 'capability_approval_resolved')
      ).toMatchObject([{ approvalId: pending.ticket.approvalId, outcome: 'granted' }])
    );
    expect(events.filter((event) => event.type === 'capability_approval_resolved')).toMatchObject([
      { data: { approvalId: pending.ticket.approvalId, outcome: 'granted' } },
    ]);
    native.finish();
    await feeding;
    const rows = store.readAll('s1');
    expect(rows.filter((event) => event.type === 'capability_approval_required')).toHaveLength(1);
    expect(rows.filter((event) => event.type === 'capability_approval_resolved')).toHaveLength(1);
    expect(new Set(rows.map((event) => event.seq)).size).toBe(rows.length);
    expect(store.readAll('other-chat')).toEqual([]);
  });

  it('cancels a real hold on interrupt and assembles fresh current facts for the next turn', async () => {
    const f = await fixture(),
      run = await f.start(),
      caller = await f.caller(),
      facts = caller.read();
    const pending = hold(f, facts, 'interrupt');
    const stop = f.runtime.interruptQuery('s1');
    expect(facts.signal.aborted).toBe(true);
    await expect(pending.held).resolves.toBe('timeout');
    await run.finished;
    await expect(stop).resolves.toMatchObject({ outcome: 'acked' });
    await expect(caller.assertCurrent()).rejects.toThrow();
    expect(() => caller.read()).toThrow(RuntimeToolContextUnavailableError);
    const next = await f.start(),
      current = await f.caller();
    expect(current.read().signal.aborted).toBe(false);
    expect(current.read().session).not.toBe(facts.session);
    await expect(current.assertCurrent()).resolves.toBeUndefined();
    next.native.finish();
    await next.finished;
  });

  it('opens tool context once the checked message is ready and closes it at completion', async () => {
    const entered = deferred();
    const resume = deferred();
    const f = await fixture({
      beforeResourceLoad: () => {
        entered.resolve();
        return resume.promise;
      },
    });
    const running = f.start();
    try {
      await Promise.race([entered.promise, running]);
      expect(f.engine.runs).toHaveLength(0);
      expect(f.opens.mock.calls[0]![1].readToolTurn?.()).toBeUndefined();
    } finally {
      resume.resolve();
    }
    const run = await running;
    const caller = await f.caller();
    const facts = caller.read();
    expect(facts.signal.aborted).toBe(false);
    run.native.finish();
    await run.finished;
    expect(facts.signal.aborted).toBe(true);
    expect(f.opens.mock.calls[0]![1].readToolTurn?.()).toBeUndefined();
  });
});
