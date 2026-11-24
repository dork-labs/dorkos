/**
 * Shared setup for the load-gate-hold tests, split from one file by subject.
 *
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
import { afterEach, beforeEach, expect, vi, type Mock } from 'vitest';
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import { LOAD_WAIT_STATUS } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { createLoadGate, type LoadGate } from '../../../../../core/load-gate/load-gate.js';
import { fixedLoadSource } from '../../../../../core/load-gate/load-source.js';
import { TicketQueue } from '../../../../../core/load-gate/ticket-queue.js';
import { makeAppServerHarness, PERSON_HOME } from '../../../__tests__/app-server-harness.js';
import { REPLY, type FakeTurnScript } from '../../../__tests__/fake-app-server.js';
import type { HeavyAskDeps } from '../../load-gate-hold.js';

export const MINUTE = 60_000;

export const POLL = 5_000;

export const ASK = 'item/commandExecution/requestApproval';

export let dir: string;

export let settings: LoadGateSettings;

export type Harness = ReturnType<typeof makeAppServerHarness>;

export const harnesses: Harness[] = [];

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
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock and a sleep that only move when the test says (the gate's own tests' shape). */
export function steppedTime() {
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
export function machine(load = 20, gate?: () => LoadGate) {
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
  const log: { warn: Mock } = { warn: vi.fn() };
  const deps: HeavyAskDeps = {
    gate: gate ?? (() => real),
    settings: () => settings,
    log,
    now: time.now,
  };
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
export function commandItem(command: string, itemId: string) {
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
export function askingTurn(command: string, itemId: string): FakeTurnScript {
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
export function askingThenParkedTurn(command: string, itemId: string): FakeTurnScript {
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
export function runningCommand(command: string, itemId: string) {
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
export async function until(
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

/** Shared helper for the load-gate-hold tests: `rest`. */
export async function rest(gen: AsyncGenerator<StreamEvent>, seen: StreamEvent[] = []) {
  for await (const event of gen) seen.push(event);
  return seen;
}

/** The wait's words, as the chat shows them. */
export function waitWords(event: StreamEvent): string {
  expect(event).toMatchObject({ type: 'system_status', data: { status: LOAD_WAIT_STATUS } });
  return (event.data as { message: string }).message;
}

/** Every reply DorkOS wrote to the fake Codex so far. */
export function replies(h: Harness): unknown[] {
  return h.host
    .home(PERSON_HOME)
    .processes.flatMap((fake) => fake.received.filter((m) => m.method === REPLY))
    .map((m) => m.params);
}

/** A Full-access turn request. Rendering Full's file profile reads the disk, so its folders exist. */
export function fullAccess(h: Harness, sessionId: string) {
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
