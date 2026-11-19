/**
 * The load gate on a Codex agent's shell (DOR-4209), driven through the real app-server transport
 * over the fake `codex app-server`, with a real gate over a temp queue folder, a load the test sets,
 * and a clock and sleep the test steps by hand.
 *
 * The rule under test above all: the hold waits and never decides. Every Codex command ask still
 * reaches the transport's own handling (the card a person answers), and nothing is written to Codex
 * while an ask waits.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import { LOAD_WAIT_STATUS } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { createLoadGate, type LoadGate } from '../../../../core/load-gate/load-gate.js';
import { fixedLoadSource } from '../../../../core/load-gate/load-source.js';
import { TicketQueue } from '../../../../core/load-gate/ticket-queue.js';
import { makeAppServerHarness, PERSON_HOME } from '../../__tests__/app-server-harness.js';
import { REPLY, type FakeTurnScript } from '../../__tests__/fake-app-server.js';
import type { HeavyAskDeps } from '../load-gate-hold.js';

const MINUTE = 60_000;
const POLL = 5_000;
const ASK = 'item/commandExecution/requestApproval';

let dir: string;
let settings: LoadGateSettings;

type Harness = ReturnType<typeof makeAppServerHarness>;
const harnesses: Harness[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-codex-load-gate-'));
  settings = {
    enabled: true,
    maxLoad: 16,
    slots: 1,
    maxWaitMinutes: 60,
    hardCapMinutes: 240,
    heavyCommands: { add: [], remove: [] },
  };
});

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Let every waiter finish the check it is in, and the fake's pipes deliver what they hold. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock and a sleep that only move when the test says (the gate's own tests' shape). */
function steppedTime() {
  let now = Date.UTC(2026, 10, 18, 12);
  let wakers: (() => void)[] = [];
  return {
    now: () => now,
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        wakers.push(resolve);
        signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), {
          once: true,
        });
      }),
    async step(ms: number) {
      now += ms;
      const waking = wakers;
      wakers = [];
      for (const wake of waking) wake();
      await settle();
    },
  };
}

/** One busy machine: a real gate over the temp folder, and the transport wired to it. */
function machine(load = 20, gate?: () => LoadGate) {
  const time = steppedTime();
  const loadSource = fixedLoadSource(load);
  const lines: string[] = [];
  const real = createLoadGate({
    config: () => settings,
    dir,
    loadSource,
    now: time.now,
    sleep: time.sleep,
    pollMs: POLL,
    noticeEveryMs: MINUTE,
    log: (line) => lines.push(line),
  });
  const log = { warn: vi.fn() };
  const deps: HeavyAskDeps = { gate: gate ?? (() => real), settings: () => settings, log };
  const h = makeAppServerHarness({ loadGate: deps });
  harnesses.push(h);
  return {
    h,
    time,
    loadSource,
    lines,
    log,
    gate: real,
    queue: new TicketQueue({ dir, now: time.now }),
  };
}

/** A command item that Codex asks about before it runs, the way 0.154 does. */
function commandItem(command: string, itemId: string) {
  return {
    type: 'commandExecution',
    id: itemId,
    command,
    cwd: '/project',
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [{ type: 'unknown', command }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}

/** A turn that asks to run `command`, runs it only on a yes, and completes. */
function askingTurn(command: string, itemId: string): FakeTurnScript {
  return async (ctx) => {
    const item = commandItem(command, itemId);
    ctx.emit('item/started', { item, startedAtMs: Date.now() });
    const reply = (await ctx.serverRequest(ASK, {
      kind: 'command',
      itemId,
      command,
      cwd: '/project',
      availableDecisions: ['accept', 'decline', 'cancel'],
    })) as { decision?: unknown };
    const ran = reply.decision === 'accept';
    ctx.emit('item/completed', {
      item: { ...item, status: ran ? 'completed' : 'declined', exitCode: ran ? 0 : null },
    });
    ctx.complete('completed');
  };
}

/** A turn that asks about `command`, then waits for a stop, never for the reply. */
function askingThenParkedTurn(command: string, itemId: string): FakeTurnScript {
  return async (ctx) => {
    ctx.emit('item/started', { item: commandItem(command, itemId), startedAtMs: Date.now() });
    void ctx.serverRequest(ASK, { kind: 'command', itemId, command, cwd: '/project' });
    await ctx.turn.interrupted;
    ctx.complete('interrupted');
  };
}

/**
 * A turn that runs `command` without asking, the way Full access (or a command its sandbox allows)
 * does, and keeps it running until the test ends it: with its `item/completed`, or with the turn
 * alone.
 */
function runningCommand(command: string, itemId: string) {
  let end!: (how: 'completed' | 'turn-only') => void;
  const ended = new Promise<'completed' | 'turn-only'>((resolve) => (end = resolve));
  const script: FakeTurnScript = async (ctx) => {
    const item = commandItem(command, itemId);
    ctx.emit('item/started', { item, startedAtMs: Date.now() });
    const how = await Promise.race([ended, ctx.turn.interrupted.then(() => 'stopped' as const)]);
    if (how === 'completed') {
      ctx.emit('item/completed', { item: { ...item, status: 'completed', exitCode: 0 } });
    }
    ctx.complete(how === 'stopped' ? 'interrupted' : 'completed');
  };
  return { script, end };
}

/** Read a running turn until an event of one of `types`, keeping what was read. */
async function until(
  gen: AsyncGenerator<StreamEvent>,
  types: StreamEvent['type'] | StreamEvent['type'][],
  seen: StreamEvent[] = []
): Promise<StreamEvent> {
  const wanted = Array.isArray(types) ? types : [types];
  for (;;) {
    const next = await gen.next();
    if (next.done) throw new Error(`the turn ended before ${wanted}: ${JSON.stringify(seen)}`);
    seen.push(next.value);
    if (wanted.includes(next.value.type)) return next.value;
  }
}

async function rest(gen: AsyncGenerator<StreamEvent>, seen: StreamEvent[] = []) {
  for await (const event of gen) seen.push(event);
  return seen;
}

/** The wait's words, as the chat shows them. */
function waitWords(event: StreamEvent): string {
  expect(event).toMatchObject({ type: 'system_status', data: { status: LOAD_WAIT_STATUS } });
  return (event.data as { message: string }).message;
}

/** Every reply DorkOS wrote to the fake Codex so far. */
function replies(h: Harness): unknown[] {
  return h.host
    .home(PERSON_HOME)
    .processes.flatMap((fake) => fake.received.filter((m) => m.method === REPLY))
    .map((m) => m.params);
}

describe('the acceptance test: two Codex chats on one busy computer', () => {
  it('holds both heavy asks in order, asks a person only once each gets its turn, and passes ls at once', async () => {
    const { h, time, loadSource, queue } = machine(20);
    const home = h.host.home(PERSON_HOME);
    home.nextTurn(askingTurn('pnpm build', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    expect(waitWords(await until(ana, 'system_status'))).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    home.nextTurn(askingTurn('pnpm test', 'b-1'));
    const bo = h.transport.runTurn(h.request({ sessionId: 'bo' }));
    expect(waitWords(await until(bo, 'system_status'))).toBe(
      'Waiting for the computer to calm down. 2nd in line.'
    );
    expect(queue.list()).toHaveLength(2);
    // Held, never answered: nothing has been written to Codex for either ask.
    expect(replies(h)).toEqual([]);

    // A light command's ask goes straight to its card while both wait.
    home.nextTurn(askingTurn('ls -la', 'c-1'));
    const cy = h.transport.runTurn(h.request({ sessionId: 'cy' }));
    const cySeen: StreamEvent[] = [];
    await until(cy, 'approval_required', cySeen);
    expect(cySeen.some((event) => event.type === 'system_status')).toBe(false);
    h.transport.answerApproval('cy', 'c-1', true);
    await rest(cy);

    loadSource.set(4);
    await time.step(POLL);
    // Ana's turn came: her card goes up, and its slot came back as it did.
    await until(ana, 'approval_required');
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(1);

    await time.step(POLL);
    await until(bo, 'approval_required');
    expect(queue.list()).toHaveLength(0);

    // The person decides each, and only the person: one yes, one no.
    h.transport.answerApproval('ana', 'a-1', true);
    h.transport.answerApproval('bo', 'b-1', false);
    const anaAfter = await rest(ana);
    const boAfter = await rest(bo);
    expect(anaAfter.find((e) => e.type === 'tool_call_end')).toMatchObject({
      data: { toolCallId: 'a-1', status: 'complete' },
    });
    expect(boAfter.find((e) => e.type === 'tool_call_end')).toMatchObject({
      data: { toolCallId: 'b-1', status: 'error' },
    });
    expect(replies(h)).toEqual([
      { decision: 'accept' },
      { decision: 'accept' },
      { decision: 'decline' },
    ]);
    expect(queue.runningCount()).toBe(0);
  });

  it('says the place again every minute, and names neither the command nor the chat in it', async () => {
    const { h, time, lines, log } = machine(20);
    h.host.home(PERSON_HOME).nextTurn(askingTurn('pnpm build --filter secret-project', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana-secret-chat' }));
    const seen: StreamEvent[] = [];
    await until(ana, 'system_status', seen);
    await time.step(MINUTE);
    await until(ana, 'system_status', seen);
    const notices = seen.filter((event) => event.type === 'system_status');
    expect(notices).toHaveLength(2);
    expect(JSON.stringify(notices)).not.toMatch(/secret|pnpm/);
    expect(JSON.stringify([lines, log.warn.mock.calls])).not.toMatch(/secret/);
    await h.transport.interrupt('ana-secret-chat');
    await rest(ana);
  });
});

describe('the hold waits and never decides', () => {
  it('a gate that breaks lets the ask through to its card, logging no command and no message', async () => {
    const { h, log } = machine(20, () => {
      throw new Error('EACCES /Users/someone/secret-project');
    });
    h.host.home(PERSON_HOME).nextTurn(askingTurn('pnpm build --filter secret-project', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'approval_required');
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { error: 'Error' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/secret/);
    // The person still decides: a no is a no.
    h.transport.answerApproval('ana', 'a-1', false);
    await rest(ana);
    expect(replies(h)).toEqual([{ decision: 'decline' }]);
  });

  it('a gate turned off holds nothing', async () => {
    settings.enabled = false;
    const { h, queue } = machine(20);
    h.host.home(PERSON_HOME).nextTurn(askingTurn('pnpm build', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    const seen: StreamEvent[] = [];
    await until(ana, 'approval_required', seen);
    expect(seen.some((event) => event.type === 'system_status')).toBe(false);
    expect(queue.list()).toHaveLength(0);
    h.transport.answerApproval('ana', 'a-1', true);
    await rest(ana);
  });
});

describe('a waiting ask leaves the line', () => {
  it('when the turn is stopped, and the next chat moves up', async () => {
    const { h, time, loadSource, queue } = machine(20);
    const home = h.host.home(PERSON_HOME);
    home.nextTurn(askingThenParkedTurn('pnpm build', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    home.nextTurn(askingTurn('pnpm test', 'b-1'));
    const bo = h.transport.runTurn(h.request({ sessionId: 'bo' }));
    await until(bo, 'system_status');

    const receipt = await h.transport.interrupt('ana');
    expect(receipt.outcome).toBe('acked');
    const anaAfter = await rest(ana);
    expect(anaAfter.filter((e) => e.type === 'done')).toHaveLength(1);
    await settle();
    expect(queue.list()).toHaveLength(1);
    // Her turn is over, so nobody is asked: no card, and the method's own no, never a yes.
    expect(anaAfter.some((event) => event.type === 'approval_required')).toBe(false);
    await vi.waitFor(() => expect(replies(h)).toEqual([{ decision: 'decline' }]));

    await time.step(MINUTE);
    expect(waitWords(await until(bo, 'system_status'))).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    loadSource.set(4);
    await time.step(POLL);
    await until(bo, 'approval_required');
    h.transport.answerApproval('bo', 'b-1', true);
    await rest(bo);
    expect(queue.list()).toHaveLength(0);
  });

  it('when Codex withdraws the ask, and nobody is asked about it', async () => {
    const { h, queue } = machine(20);
    let withdraw!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      ctx.emit('item/started', { item: commandItem('pnpm build', 'a-1'), startedAtMs: Date.now() });
      void ctx.serverRequest(ASK, { kind: 'command', itemId: 'a-1', command: 'pnpm build' });
      await new Promise<void>((resolve) => (withdraw = resolve));
      ctx.server.send({
        method: 'serverRequest/resolved',
        params: { threadId: ctx.turn.threadId, requestId: ctx.server.lastServerRequestId },
      });
      await ctx.tick();
      ctx.agentMessage('ok');
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    expect(queue.list()).toHaveLength(1);
    withdraw();
    const after = await rest(ana);
    await settle();
    expect(queue.list()).toHaveLength(0);
    expect(after.some((event) => event.type === 'approval_required')).toBe(false);
    // The method's own no, which Codex ignores for a request it cleared: never a yes.
    expect(replies(h)).toEqual([{ decision: 'decline' }]);
  });

  it('when the Codex process goes away', async () => {
    const { h, queue } = machine(20);
    h.host.home(PERSON_HOME).nextTurn(askingThenParkedTurn('pnpm build', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    expect(queue.list()).toHaveLength(1);
    h.host.home(PERSON_HOME).processes[0]!.kill('SIGKILL');
    const after = await rest(ana);
    expect(after.filter((e) => e.type === 'done')).toHaveLength(1);
    await settle();
    expect(queue.list()).toHaveLength(0);
    expect(queue.runningCount()).toBe(0);
    expect(after.some((event) => event.type === 'approval_required')).toBe(false);
  });

  it('a turn that ends on its own while an ask waits raises no card for it', async () => {
    const { h, queue } = machine(20);
    let end!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      ctx.emit('item/started', { item: commandItem('pnpm build', 'a-1'), startedAtMs: Date.now() });
      void ctx.serverRequest(ASK, { kind: 'command', itemId: 'a-1', command: 'pnpm build' });
      await new Promise<void>((resolve) => (end = resolve));
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    end();
    const after = await rest(ana);
    await settle();
    expect(queue.list()).toHaveLength(0);
    expect(after.some((event) => event.type === 'approval_required')).toBe(false);
    await vi.waitFor(() => expect(replies(h)).toEqual([{ decision: 'decline' }]));
  });
});

describe('a chat never waits behind itself', () => {
  it('two heavy asks of one turn share one ticket, and each gets its card when it comes', async () => {
    const { h, time, loadSource, queue } = machine(20);
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      const asks = (['a-1', 'a-2'] as const).map((itemId, index) => {
        const command = index === 0 ? 'pnpm typecheck' : 'pnpm lint';
        ctx.emit('item/started', { item: commandItem(command, itemId), startedAtMs: Date.now() });
        return ctx.serverRequest(ASK, { kind: 'command', itemId, command, cwd: '/project' });
      });
      await Promise.all(asks);
      for (const [itemId, command] of [
        ['a-1', 'pnpm typecheck'],
        ['a-2', 'pnpm lint'],
      ] as const) {
        ctx.emit('item/completed', {
          item: { ...commandItem(command, itemId), status: 'completed' },
        });
      }
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    await settle();
    expect(queue.list()).toHaveLength(1);

    loadSource.set(4);
    await time.step(POLL);
    const seen: StreamEvent[] = [];
    await until(ana, 'approval_required', seen);
    await until(ana, 'approval_required', seen);
    const cards = seen.filter((event) => event.type === 'approval_required');
    expect(cards.map((card) => (card.data as { toolCallId: string }).toolCallId).sort()).toEqual([
      'a-1',
      'a-2',
    ]);
    expect(queue.list()).toHaveLength(0);
    expect(queue.runningCount()).toBe(0);
    h.transport.answerApproval('ana', 'a-1', true);
    h.transport.answerApproval('ana', 'a-2', false);
    await rest(ana);
  });

  it('Codex withdrawing one of them leaves the wait standing for the other', async () => {
    const { h, time, loadSource, queue } = machine(20);
    let withdraw!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      ctx.emit('item/started', { item: commandItem('pnpm lint', 'a-1'), startedAtMs: Date.now() });
      void ctx.serverRequest(ASK, { kind: 'command', itemId: 'a-1', command: 'pnpm lint' });
      const first = ctx.server.lastServerRequestId;
      ctx.emit('item/started', { item: commandItem('pnpm test', 'a-2'), startedAtMs: Date.now() });
      const second = ctx.serverRequest(ASK, {
        kind: 'command',
        itemId: 'a-2',
        command: 'pnpm test',
      });
      await new Promise<void>((resolve) => (withdraw = resolve));
      ctx.server.send({
        method: 'serverRequest/resolved',
        params: { threadId: ctx.turn.threadId, requestId: first },
      });
      await second;
      for (const [itemId, command] of [
        ['a-1', 'pnpm lint'],
        ['a-2', 'pnpm test'],
      ] as const) {
        ctx.emit('item/completed', {
          item: { ...commandItem(command, itemId), status: 'declined' },
        });
      }
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    withdraw();
    await settle();
    await settle();
    expect(queue.list()).toHaveLength(1);
    loadSource.set(4);
    await time.step(POLL);
    const card = await until(ana, 'approval_required');
    expect(card.data).toMatchObject({ toolCallId: 'a-2' });
    h.transport.answerApproval('ana', 'a-2', true);
    await rest(ana);
    expect(queue.list()).toHaveLength(0);
  });
});

/** A Full-access turn request. Rendering Full's file profile reads the disk, so its folders exist. */
function fullAccess(h: Harness, sessionId: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-load-gate-full-')));
  const cwd = path.join(root, 'project');
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  for (const folder of [cwd, data, home]) fs.mkdirSync(folder);
  const base = h.request({ sessionId });
  const roots = { cwd, data, home, accounts: [], agentFolders: [cwd], agentHomes: [] };
  return {
    request: h.request({
      sessionId,
      cwd,
      settings: { permissionMode: 'bypassPermissions' },
      tools: { ...base.tools, filePolicy: { writable: [], roots } },
    }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe('a command Codex runs without asking counts in the line (DOR-4743)', () => {
  it('at Full access fills the slot, so another chat’s build waits until it completes', async () => {
    const { h, time, queue, gate } = machine(4);
    const build = runningCommand('pnpm build', 'full-1');
    h.host.home(PERSON_HOME).nextTurn(build.script);
    const full = fullAccess(h, 'full');
    try {
      const ana = h.transport.runTurn(full.request);
      await until(ana, 'tool_call_start');
      const fake = h.host.home(PERSON_HOME).processes[0]!;
      // Codex is told never to ask, so there is no ask to hold: the command is already running.
      expect(fake.requestsOf('turn/start')[0]).toMatchObject({ approvalPolicy: 'never' });
      expect(queue.runningCount()).toBe(1);

      // Any other heavy job, on any runtime, waits behind it, though the computer is calm.
      const other = gate.waitForSlot({ job: 'tsc' });
      let ran = false;
      void other.then(() => (ran = true));
      await time.step(POLL);
      expect(ran).toBe(false);
      expect(queue.list()).toHaveLength(1);

      build.end('completed');
      const after = await rest(ana);
      expect(after.some((event) => event.type === 'system_status')).toBe(false);
      expect(after.find((e) => e.type === 'tool_call_end')).toMatchObject({
        data: { toolCallId: 'full-1', status: 'complete' },
      });
      await time.step(POLL);
      expect(ran).toBe(true);
      (await other).release();
      expect(queue.runningCount()).toBe(0);
    } finally {
      full.cleanup();
    }
  });

  it('gives the slot back when the turn ends without the command’s completion', async () => {
    const { h, queue } = machine(20);
    const build = runningCommand('pnpm build', 'a-1');
    h.host.home(PERSON_HOME).nextTurn(build.script);
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'tool_call_start');
    expect(queue.runningCount()).toBe(1);
    build.end('turn-only');
    await rest(ana);
    await settle();
    expect(queue.runningCount()).toBe(0);
  });

  it('gives the slot back when the Codex process goes away', async () => {
    const { h, queue } = machine(20);
    h.host.home(PERSON_HOME).nextTurn(runningCommand('pnpm build', 'a-1').script);
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'tool_call_start');
    expect(queue.runningCount()).toBe(1);
    h.host.home(PERSON_HOME).processes[0]!.kill('SIGKILL');
    const after = await rest(ana);
    expect(after.filter((e) => e.type === 'done')).toHaveLength(1);
    await settle();
    expect(queue.runningCount()).toBe(0);
  });

  it('takes no slot for a light command', async () => {
    const { h, queue } = machine(20);
    const listing = runningCommand('ls -la', 'l-1');
    h.host.home(PERSON_HOME).nextTurn(listing.script);
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'tool_call_start');
    expect(queue.runningCount()).toBe(0);
    listing.end('completed');
    await rest(ana);
  });

  it('an asked command counts once: nothing while its ask waits and its card is up, one slot while it runs', async () => {
    const { h, time, loadSource, queue } = machine(20);
    let finish!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      const item = commandItem('pnpm build', 'a-1');
      // 0.154's order: the command is reported started, then asked about.
      ctx.emit('item/started', { item, startedAtMs: Date.now() });
      await ctx.serverRequest(ASK, { kind: 'command', itemId: 'a-1', command: 'pnpm build' });
      await new Promise<void>((resolve) => (finish = resolve));
      ctx.emit('item/completed', { item: { ...item, status: 'completed', exitCode: 0 } });
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    expect(waitWords(await until(ana, ['system_status', 'approval_required']))).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    await settle();
    expect(queue.list()).toHaveLength(1);
    expect(queue.runningCount()).toBe(0);

    loadSource.set(4);
    await time.step(POLL);
    await until(ana, 'approval_required');
    expect(queue.list()).toHaveLength(0);
    expect(queue.runningCount()).toBe(0);

    h.transport.answerApproval('ana', 'a-1', true);
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    expect(queue.runningCount()).toBe(1);
    finish();
    await rest(ana);
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(0);
    expect(replies(h)).toEqual([{ decision: 'accept' }]);
  });
});

describe('a new Codex reply waits to start on a busy computer while Codex commands run (DOR-4743)', () => {
  /** Ana's chat runs a heavy command without asking; it holds a slot until `end`. */
  async function anaRunning(m: ReturnType<typeof machine>) {
    const build = runningCommand('pnpm build', 'a-1');
    m.h.host.home(PERSON_HOME).nextTurn(build.script);
    const ana = m.h.transport.runTurn(m.h.request({ sessionId: 'ana' }));
    await until(ana, 'tool_call_start');
    expect(m.queue.runningCount()).toBe(1);
    return { ana, build, fake: m.h.host.home(PERSON_HOME).processes[0]! };
  }

  it('waits, saying so, and starts once the slot frees', async () => {
    const m = machine(20);
    const { ana, build, fake } = await anaRunning(m);
    const bo = m.h.transport.runTurn(m.h.request({ sessionId: 'bo' }));
    expect(waitWords(await until(bo, 'system_status'))).toBe(
      'Waiting for the computer to calm down before starting.'
    );
    await m.time.step(POLL);
    // Codex was never told about Bo's message.
    expect(fake.requestsOf('turn/start')).toHaveLength(1);

    build.end('completed');
    await rest(ana);
    await m.time.step(POLL);
    const after = await rest(bo);
    expect(fake.requestsOf('turn/start')).toHaveLength(2);
    expect(after.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('starts once the computer calms down, while the command still runs', async () => {
    const m = machine(20);
    const { ana, build, fake } = await anaRunning(m);
    const bo = m.h.transport.runTurn(m.h.request({ sessionId: 'bo' }));
    await until(bo, 'system_status');
    m.loadSource.set(4);
    await m.time.step(POLL);
    await rest(bo);
    expect(fake.requestsOf('turn/start')).toHaveLength(2);
    build.end('completed');
    await rest(ana);
  });

  it('a Stop while it waits ends it, and Codex is never told about the message', async () => {
    const m = machine(20);
    const { ana, build, fake } = await anaRunning(m);
    const stop = new AbortController();
    const bo = m.h.transport.runTurn(m.h.request({ sessionId: 'bo', signal: stop.signal }));
    await until(bo, 'system_status');
    stop.abort();
    expect(await m.h.transport.interrupt('bo')).toMatchObject({ outcome: 'not-running' });
    expect(await rest(bo)).toEqual([{ type: 'done', data: { sessionId: 'bo' } }]);
    m.loadSource.set(4);
    await m.time.step(POLL);
    expect(fake.requestsOf('turn/start')).toHaveLength(1);
    build.end('completed');
    await rest(ana);
  });

  it('does not wait at all while the computer is calm', async () => {
    const m = machine(4);
    const { ana, build, fake } = await anaRunning(m);
    const bo = await m.h.run(m.h.request({ sessionId: 'bo' }));
    expect(bo.some((event) => event.type === 'system_status')).toBe(false);
    expect(fake.requestsOf('turn/start')).toHaveLength(2);
    build.end('completed');
    await rest(ana);
  });

  it('does not wait on a busy computer while no Codex command runs', async () => {
    const { h } = machine(20);
    const bo = await h.run(h.request({ sessionId: 'bo' }));
    expect(bo.some((event) => event.type === 'system_status')).toBe(false);
    expect(bo.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});
