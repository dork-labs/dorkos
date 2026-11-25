/**
 * The load gate on an OpenCode agent's shell (DOR-4209), driven through the real approval pass
 * (`enforceApprovals`), the real shell guards and a real gate over a temp queue folder. Only the
 * sidecar's reply route is faked, and the load, clock and sleep are the test's.
 *
 * The rule under test above all: the hold waits and never decides. The sidecar hears nothing while
 * an ask waits, and afterwards it hears exactly what the normal decision says: the shell guard's
 * refusal, the level's approval, or nothing at all while a person's card is up.
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
import { createLoadGate, type LoadGate } from '../../../core/load-gate/load-gate.js';
import { fixedLoadSource } from '../../../core/load-gate/load-source.js';
import type { RuntimeWaitDeps } from '../../../core/load-gate/runtime-wait.js';
import { TicketQueue } from '../../../core/load-gate/ticket-queue.js';
import {
  makeGuardProject,
  type GuardProject,
} from '../../shared/policy/__tests__/package-hook-fixture.js';
import {
  enforceApprovals,
  PendingApprovalStore,
  STOPPED_WHILE_WAITING_REASON,
  type ApprovalGateDeps,
  type ApprovalRouting,
} from '../messaging/approvals.js';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import { OpenCodeSessionRegistry } from '../sessions/session-registry.js';

const MINUTE = 60_000;
const POLL = 5_000;

let dir: string;
let project: GuardProject;
let settings: LoadGateSettings;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-opencode-load-gate-'));
  project = makeGuardProject();
  settings = {
    enabled: true,
    maxLoad: 16,
    slots: 1,
    maxWaitMinutes: 60,
    hardCapMinutes: 240,
    heavyCommands: { add: [], remove: [] },
  };
});

afterEach(() => {
  project.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Let every waiter finish the check it is in. */
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

/** One busy machine: a real gate over the temp folder, and the runtime's approval state. */
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
  const loadGate: RuntimeWaitDeps = { gate: gate ?? (() => real), settings: () => settings, log };
  // The sidecar's reply route: the one edge faked here.
  const respond = vi.fn().mockResolvedValue({ data: true });
  const provider = {
    getClient: async () => ({ postSessionIdPermissionsPermissionId: respond }),
  } as unknown as OpenCodeClientProvider;
  const registry = new OpenCodeSessionRegistry();
  const deps: ApprovalGateDeps = {
    provider,
    registry,
    approvals: new PendingApprovalStore(),
    loadGate,
  };
  /** Every chat's turn stops with this unless a test gives it its own stop. */
  const stopAll = new AbortController();
  /** One chat's turn at `mode`, whose asks gate the given tool calls. */
  const chat = (
    sessionId: string,
    mode: string,
    calls: Record<string, string>,
    extra: Partial<ApprovalRouting> = {}
  ): ApprovalRouting => {
    registry.register(sessionId, { permissionMode: mode });
    return {
      sessionId,
      ocSessionId: `ses_${sessionId}`,
      cwd: project.dir,
      directory: project.dir,
      permissions: {
        pendingPermissionSessions: new Map(
          Object.keys(calls).map((id): [string, string] => [id, `ses_${sessionId}`])
        ),
        permissionCallIds: new Map(Object.entries(calls)),
      },
      signal: stopAll.signal,
      ...extra,
    };
  };
  const queue = new TicketQueue({ dir, now: time.now });
  return { time, loadSource, lines, log, respond, deps, chat, queue, stopAll };
}

/** A permission ask, as the session mapper hands it over. */
function askFor(toolName: string, command: string, permissionId: string): StreamEvent {
  return {
    type: 'approval_required',
    data: {
      toolCallId: permissionId,
      toolName,
      input: JSON.stringify({ patterns: [command], command }),
      timeoutMs: 1,
      startedAt: 1,
      hasSuggestions: false,
    },
  };
}

/** A `bash` ask. */
const bashAsk = (command: string, permissionId: string): StreamEvent =>
  askFor('bash', command, permissionId);

/** A tool call's end, as the part mapper hands it over. */
function callEnded(callId: string, status: 'complete' | 'error'): StreamEvent {
  return { type: 'tool_call_end', data: { toolCallId: callId, toolName: 'bash', status } };
}

/** Run one event through the pass in the background, keeping what it yields. */
function pass(deps: ApprovalGateDeps, turn: ApprovalRouting, event: StreamEvent) {
  const state = { events: [] as StreamEvent[], done: false, error: undefined as unknown };
  void (async () => {
    for await (const out of enforceApprovals(deps, turn, event)) state.events.push(out);
    state.done = true;
  })().catch((error: unknown) => {
    state.error = error;
  });
  return state;
}

/** Run one event through the pass to its end. */
async function passAll(deps: ApprovalGateDeps, turn: ApprovalRouting, event: StreamEvent) {
  const out: StreamEvent[] = [];
  for await (const yielded of enforceApprovals(deps, turn, event)) out.push(yielded);
  return out;
}

/** The wait's words, as the chat shows them. */
function waitWords(events: StreamEvent[]): string[] {
  return events
    .filter((event) => event.type === 'system_status')
    .map((event) => {
      expect(event).toMatchObject({ data: { status: LOAD_WAIT_STATUS } });
      return (event.data as { message: string }).message;
    });
}

const approvedOnce = (permissionID: string, ses: string) => ({
  path: { id: ses, permissionID },
  body: { response: 'once' },
});

describe('the acceptance test: two OpenCode chats on one busy computer', () => {
  it('holds both heavy jobs, runs them one at a time in order once it calms, and passes ls at once', async () => {
    const m = machine(20);
    const ana = m.chat('ana', 'bypassPermissions', { 'perm-a': 'call-a', 'perm-ls': 'call-ls' });
    const bo = m.chat('bo', 'bypassPermissions', { 'perm-b': 'call-b' });
    const anaBuild = pass(m.deps, ana, bashAsk('pnpm build', 'perm-a'));
    await settle();
    const boTests = pass(m.deps, bo, bashAsk('pnpm test', 'perm-b'));
    await settle();
    expect(waitWords(anaBuild.events)).toEqual([
      'Waiting for the computer to calm down. Next in line.',
    ]);
    expect(waitWords(boTests.events)).toEqual([
      'Waiting for the computer to calm down. 2nd in line.',
    ]);
    // Held, never answered: the sidecar has heard nothing about either.
    expect(m.respond).not.toHaveBeenCalled();

    // A light command is answered at once, by the level, while both wait.
    expect(await passAll(m.deps, ana, bashAsk('ls -la', 'perm-ls'))).toEqual([]);
    expect(m.respond).toHaveBeenCalledWith(approvedOnce('perm-ls', 'ses_ana'));
    expect(m.queue.list()).toHaveLength(2);

    await m.time.step(POLL);
    expect(anaBuild.done).toBe(false);
    m.loadSource.set(4);
    await m.time.step(POLL);
    await vi.waitFor(() => expect(anaBuild.done).toBe(true));
    expect(m.respond).toHaveBeenLastCalledWith(approvedOnce('perm-a', 'ses_ana'));
    // One at a time: the slot is Ana's while her build runs.
    expect(m.queue.runningCount()).toBe(1);
    await m.time.step(POLL);
    expect(boTests.done).toBe(false);

    await passAll(m.deps, ana, callEnded('call-a', 'complete'));
    expect(m.queue.runningCount()).toBe(0);
    await m.time.step(POLL);
    await vi.waitFor(() => expect(boTests.done).toBe(true));
    expect(m.respond).toHaveBeenLastCalledWith(approvedOnce('perm-b', 'ses_bo'));
    await passAll(m.deps, bo, callEnded('call-b', 'error'));
    expect(m.queue.runningCount()).toBe(0);
    expect(m.queue.list()).toHaveLength(0);
  });
});

describe('the hold waits, and the normal decision decides', () => {
  it(
    'a heavy command the shell guard refuses is still refused once its slot comes, and gives the slot back',
    {
      timeout: 30_000,
    },
    async () => {
      project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
      const m = machine(20);
      const ana = m.chat('ana', 'bypassPermissions', { 'perm-a': 'call-a' });
      const held = pass(m.deps, ana, bashAsk('pnpm build && git stash', 'perm-a'));
      await settle();
      // The wait sits outside the shell guard's own time limit: the guard has not even run yet.
      expect(project.lastPayload()).toBeUndefined();
      expect(m.respond).not.toHaveBeenCalled();

      m.loadSource.set(4);
      await m.time.step(POLL);
      // The guard is a real process: give it time to run.
      await vi.waitFor(() => expect(held.done).toBe(true), { timeout: 20_000 });
      expect(held.error).toBeUndefined();
      expect(project.lastPayload()).toBeDefined();
      expect(held.events.at(-1)).toMatchObject({
        type: 'permission_denied',
        data: { toolCallId: 'perm-a', reasonType: 'package_hook' },
      });
      expect(m.respond).toHaveBeenCalledTimes(1);
      expect(m.respond).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ reply: 'reject' }) })
      );
      // Refused, so nothing will run: the slot came back with the refusal.
      expect(m.queue.runningCount()).toBe(0);
    }
  );

  it('a heavy command that would ask a person still asks, and the card gives its slot back', async () => {
    const m = machine(20);
    const ana = m.chat('ana', 'default', { 'perm-a': 'call-a' });
    const ask = bashAsk('pnpm build', 'perm-a');
    const held = pass(m.deps, ana, ask);
    await settle();
    m.loadSource.set(4);
    await m.time.step(POLL);
    await vi.waitFor(() => expect(held.done).toBe(true));
    // The card, exactly as the mapper made it, and nobody answered on the person's behalf.
    expect(held.events.at(-1)).toEqual(ask);
    expect(m.respond).not.toHaveBeenCalled();
    expect(m.queue.runningCount()).toBe(0);
    expect(m.queue.list()).toHaveLength(0);
    // The card's own record is the normal one: it can be answered, and it is the person's.
    expect(m.deps.approvals.take('ana', 'perm-a')).not.toBeNull();
  });
});

describe('a chat never waits behind its own slot', () => {
  it('two heavy calls in one turn, the first’s end arriving after the second’s ask: no deadlock', async () => {
    const m = machine(4);
    const ana = m.chat('ana', 'bypassPermissions', {
      'perm-a': 'call-a',
      'perm-b': 'call-b',
      'perm-h': 'call-h',
    });
    await passAll(m.deps, ana, bashAsk('pnpm typecheck', 'perm-a'));
    expect(m.queue.runningCount()).toBe(1);
    // The stream's next event is the second call's ask; the first call's end is queued behind it.
    // Even on a computer gone busy, the second call shares the chat's slot and goes on at once.
    m.loadSource.set(20);
    expect(await passAll(m.deps, ana, bashAsk('pnpm lint', 'perm-b'))).toEqual([]);
    expect(m.respond).toHaveBeenLastCalledWith(approvedOnce('perm-b', 'ses_ana'));
    // So does a helper's ask, which cannot be counted on the slot.
    ana.permissions.pendingPermissionSessions.set('perm-h', 'ses_helper');
    expect(await passAll(m.deps, ana, bashAsk('pnpm test', 'perm-h'))).toEqual([]);
    expect(m.respond).toHaveBeenLastCalledWith(approvedOnce('perm-h', 'ses_helper'));
    expect(m.queue.runningCount()).toBe(1);
    expect(m.queue.list()).toHaveLength(0);

    // Another chat still waits for it.
    m.loadSource.set(4);
    const bo = m.chat('bo', 'bypassPermissions', { 'perm-c': 'call-c' });
    const boBuild = pass(m.deps, bo, bashAsk('pnpm build', 'perm-c'));
    await settle();
    expect(waitWords(boBuild.events)).toEqual([
      'Waiting for the computer to calm down. Next in line.',
    ]);

    // The slot goes back only when the last call on it ends.
    await passAll(m.deps, ana, callEnded('call-a', 'complete'));
    expect(m.queue.runningCount()).toBe(1);
    await m.time.step(POLL);
    expect(boBuild.done).toBe(false);
    await passAll(m.deps, ana, callEnded('call-b', 'error'));
    expect(m.queue.runningCount()).toBe(0);
    await m.time.step(POLL);
    await vi.waitFor(() => expect(boBuild.done).toBe(true));
    expect(m.respond).toHaveBeenLastCalledWith(approvedOnce('perm-c', 'ses_bo'));
    await passAll(m.deps, bo, callEnded('call-c', 'complete'));
    expect(m.queue.runningCount()).toBe(0);
  });

  it('a shared call that is refused stops counting, and the chat’s slot stays for the first', async () => {
    const m = machine(4);
    const ana = m.chat('ana', 'bypassPermissions', { 'perm-a': 'call-a', 'perm-b': 'call-b' });
    await passAll(m.deps, ana, bashAsk('pnpm build', 'perm-a'));
    expect(m.queue.runningCount()).toBe(1);
    // Installed only now, and run once: the fixture's guard writes its stdin to a file inside the
    // project, and the package's yes pins that file (`hook-script-pins.ts`), so a guard that had
    // already run once would read as a changed package, lose its yes, and check nothing.
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
    const refused = await passAll(m.deps, ana, bashAsk('pnpm test && git stash', 'perm-b'));
    // The shared ask still went through the whole normal decision, and the guard refused it.
    expect(project.lastPayload()).toMatchObject({
      tool_input: { command: 'pnpm test && git stash' },
    });
    expect(refused.at(-1)).toMatchObject({
      type: 'permission_denied',
      data: { toolCallId: 'perm-b', reasonType: 'package_hook' },
    });
    expect(m.respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ reply: 'reject' }) })
    );
    expect(m.queue.runningCount()).toBe(1);
    await passAll(m.deps, ana, callEnded('call-a', 'complete'));
    expect(m.queue.runningCount()).toBe(0);
  }, 30_000);
});

describe('giving the slot back', () => {
  it('when the turn ends while the job runs', async () => {
    const m = machine(4);
    const ana = m.chat('ana', 'bypassPermissions', { 'perm-a': 'call-a' });
    await passAll(m.deps, ana, bashAsk('pnpm build', 'perm-a'));
    expect(m.queue.runningCount()).toBe(1);
    // The runtime's teardown, which every way a turn ends goes through.
    m.deps.approvals.clearSession('ana');
    expect(m.queue.runningCount()).toBe(0);
  });

  it('when the turn is stopped while the job waits at Full: refused, never auto-approved, and its ticket leaves', async () => {
    const m = machine(20);
    const stop = new AbortController();
    const ana = m.chat('ana', 'bypassPermissions', { 'perm-a': 'call-a' }, { signal: stop.signal });
    const bo = m.chat('bo', 'bypassPermissions', { 'perm-b': 'call-b' });
    const anaBuild = pass(m.deps, ana, bashAsk('pnpm build', 'perm-a'));
    await settle();
    const boTests = pass(m.deps, bo, bashAsk('pnpm test', 'perm-b'));
    await settle();
    stop.abort();
    await vi.waitFor(() => expect(anaBuild.done).toBe(true));
    // Full would have approved it on its own; a stopped chat's ask is refused instead.
    expect(m.respond).toHaveBeenCalledTimes(1);
    expect(m.respond).not.toHaveBeenCalledWith(approvedOnce('perm-a', 'ses_ana'));
    expect(m.respond).toHaveBeenCalledWith({
      url: '/permission/{requestID}/reply',
      path: { requestID: 'perm-a' },
      query: { directory: project.dir },
      body: { reply: 'reject', message: STOPPED_WHILE_WAITING_REASON },
      signal: expect.any(AbortSignal),
    });
    expect(anaBuild.events.at(-1)).toMatchObject({
      type: 'permission_denied',
      data: { toolCallId: 'perm-a', reasonType: 'turn_stopped' },
    });
    expect(m.queue.runningCount()).toBe(0);
    expect(m.queue.list()).toHaveLength(1);
    // Bo moved up.
    await m.time.step(MINUTE);
    expect(waitWords(boTests.events).at(-1)).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    m.stopAll.abort();
    await vi.waitFor(() => expect(boTests.done).toBe(true));
  });

  it('when the turn is stopped just as its slot is granted: the slot goes back, and the ask is refused', async () => {
    const m = machine(20);
    const stop = new AbortController();
    const ana = m.chat('ana', 'bypassPermissions', { 'perm-a': 'call-a' }, { signal: stop.signal });
    const held = enforceApprovals(m.deps, ana, bashAsk('pnpm build', 'perm-a'));
    // Read up to its status line, and leave it there while the computer calms and grants the slot.
    expect((await held.next()).value).toMatchObject({ type: 'system_status' });
    m.loadSource.set(4);
    await m.time.step(POLL);
    expect(m.queue.runningCount()).toBe(1);
    stop.abort();
    const rest: StreamEvent[] = [];
    for (let next = await held.next(); !next.done; next = await held.next()) rest.push(next.value);
    expect(rest.at(-1)).toMatchObject({
      type: 'permission_denied',
      data: { reasonType: 'turn_stopped' },
    });
    expect(m.respond).not.toHaveBeenCalledWith(approvedOnce('perm-a', 'ses_ana'));
    expect(m.respond).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ reply: 'reject' }) })
    );
    expect(m.queue.runningCount()).toBe(0);
  });

  it('when the call fails, and never for a call that holds none', async () => {
    const m = machine(4);
    const ana = m.chat('ana', 'bypassPermissions', { 'perm-a': 'call-a' });
    await passAll(m.deps, ana, bashAsk('pnpm build', 'perm-a'));
    expect(m.queue.runningCount()).toBe(1);
    // Another call's end leaves the slot alone, and passes through untouched.
    expect(await passAll(m.deps, ana, callEnded('call-other', 'complete'))).toEqual([
      callEnded('call-other', 'complete'),
    ]);
    expect(m.queue.runningCount()).toBe(1);
    await passAll(m.deps, ana, callEnded('call-a', 'error'));
    expect(m.queue.runningCount()).toBe(0);
  });
});
