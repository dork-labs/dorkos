/**
 * The load gate on an agent's shell (DOR-4209), driven through the hooks a launch registers, over
 * a real queue folder, with a load the test sets and a clock and sleep the test steps by hand.
 *
 * The rule under test above all: the hook holds a call and never decides one. Every answer it
 * gives is `{}`, so the shell guard's refusal and the permission flow's card are untouched by it.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import { LOAD_WAIT_STATUS, type PermissionModeId } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../../config/constants.js';
import {
  createLoadGate,
  type HeldSlot,
  type LoadGate,
  type WaitOutcome,
} from '../../../../core/load-gate/load-gate.js';
import { fixedLoadSource } from '../../../../core/load-gate/load-source.js';
import { loadWaitMessage } from '../../../../core/load-gate/runtime-wait.js';
import { TicketQueue } from '../../../../core/load-gate/ticket-queue.js';
import {
  createCanUseTool,
  type ToolApprovalContext,
} from '../../messaging/interactive-handlers.js';
import type { PendingInteraction } from '../../messaging/interaction-wait.js';
import type { ShellChecker } from '../../shell-guard/guard-host.js';
import { checkShellCommand, type ShellGuardRoots } from '../../shell-guard/shell-check.js';
import {
  createShellPathGuardHook,
  SHELL_WRITE_DENY_REASON,
} from '../../shell-guard/shell-path-guard.js';
import {
  LOAD_GATE_MATCHER,
  loadGateHooks,
  loadGateHookTimeoutSeconds,
  releaseHeavyJobsOf,
  startHeavyJobsProcess,
  type LoadGateHookDeps,
  type LoadGateHookSession,
} from '../load-gate-hook.js';

const MINUTE = 60_000;
const POLL = 5_000;
const noopLog = { debug: () => {}, info: () => {} };

let dir: string;
let settings: LoadGateSettings;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-load-gate-hook-'));
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
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Let every waiter finish the synchronous check it is in and go back to sleep. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock and a sleep that only move when the test says (the same shape as the gate's own tests). */
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
    /** Move the clock on and wake every sleeper once. */
    async step(ms: number) {
      now += ms;
      const waking = wakers;
      wakers = [];
      for (const wake of waking) wake();
      await settle();
    },
  };
}

/** One machine: a real gate over the temp folder, its load, its clock, and a reader of the folder. */
function machine(load = 20) {
  const time = steppedTime();
  const loadSource = fixedLoadSource(load);
  const lines: string[] = [];
  const gate = createLoadGate({
    config: () => settings,
    dir,
    loadSource,
    now: time.now,
    sleep: time.sleep,
    pollMs: POLL,
    noticeEveryMs: MINUTE,
    log: (line) => lines.push(line),
  });
  return { gate, time, loadSource, lines, queue: new TicketQueue({ dir, now: time.now }) };
}

/** A chat's session, as far as the hook touches it. */
function chat(sdkSessionId: string): LoadGateHookSession {
  return {
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
    lastActivity: 0,
    sdkSessionId,
  };
}

/** One launch's hooks for `session`, on `gate`. */
function hooksFor(
  session: LoadGateHookSession,
  gate: LoadGate,
  now: () => number,
  extra: Partial<LoadGateHookDeps> = {}
) {
  const log = { warn: vi.fn() };
  const hooks = loadGateHooks(
    session,
    { sessionId: 'dorkos-session', agentName: 'Ana' },
    { gate: () => gate, settings: () => settings, now, log, ...extra }
  );
  return { ...hooks, log };
}

const BASE = { session_id: 's', transcript_path: '/tmp/t.jsonl', cwd: '/work' };

function bash(command: string, toolUseId: string, agentId?: string): HookInput {
  return {
    ...BASE,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: toolUseId,
    ...(agentId ? { agent_id: agentId } : {}),
  } as HookInput;
}

function finished(toolUseId: string, event: 'PostToolUse' | 'PostToolUseFailure'): HookInput {
  return {
    ...BASE,
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: toolUseId,
    ...(event === 'PostToolUse' ? { tool_response: '' } : { error: 'exit 1' }),
  } as HookInput;
}

function call(
  matcher: HookCallbackMatcher,
  input: HookInput,
  signal: AbortSignal = new AbortController().signal
): Promise<HookJSONOutput> {
  const toolUseId = 'tool_use_id' in input ? String(input.tool_use_id) : undefined;
  return matcher.hooks[0]!(input, toolUseId, { signal });
}

/** Track a hook's answer without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
}

/** What the chat has been told about the wait, in order. */
function said(session: LoadGateHookSession): string[] {
  return session.eventQueue.map((event) => {
    expect(event).toMatchObject({ type: 'system_status', data: { status: LOAD_WAIT_STATUS } });
    return (event.data as { message: string }).message;
  });
}

/** The rule every answer of the hook is held to: nothing at all, so the normal flow decides. */
function expectNoDecision(answer: HookJSONOutput | undefined): void {
  expect(answer).toEqual({});
  expect(JSON.stringify(answer)).not.toMatch(/permissionDecision|"decision"|hookSpecificOutput/);
}

/**
 * How the CLI settles one call's `PreToolUse` answers, as its hook documentation states it: every
 * matching hook runs at once and the CLI waits for all of them; a deny beats an ask beats an allow;
 * a call no hook decided goes on to the permission flow. A model, kept deliberately small: what
 * matters here is that the gate's answer adds nothing to it.
 */
async function cliSettles(hooks: HookCallback[], input: HookInput, toolUseId: string) {
  const signal = new AbortController().signal;
  const answers = await Promise.all(hooks.map((hook) => hook(input, toolUseId, { signal })));
  const specific = answers.map(
    (answer) =>
      (
        answer as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        }
      ).hookSpecificOutput
  );
  for (const decision of ['deny', 'ask', 'allow'] as const) {
    const hit = specific.find((s) => s?.permissionDecision === decision);
    if (hit) return { decision, reason: hit.permissionDecisionReason, answers };
  }
  return { decision: 'permission flow' as const, answers };
}

describe('the acceptance test: two chats on one busy computer', () => {
  it('holds both heavy jobs, runs them one at a time in order once it calms, and passes ls at once', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const ana = chat('sdk-ana');
    const bo = chat('sdk-bo');
    const anaHooks = hooksFor(ana, gate, time.now);
    const boHooks = hooksFor(bo, gate, time.now);

    const anaBuild = track(call(anaHooks.wait, bash('pnpm build', 'ana-1')));
    const boTests = track(call(boHooks.wait, bash('pnpm test', 'bo-1')));
    await settle();
    // A light command passes while both wait.
    expectNoDecision(await call(boHooks.wait, bash('ls -la', 'bo-2')));
    expect(anaBuild.done).toBe(false);
    expect(boTests.done).toBe(false);
    expect(said(ana)).toEqual(['Waiting for the computer to calm down. Next in line.']);
    expect(said(bo)).toEqual(['Waiting for the computer to calm down. 2nd in line.']);

    await time.step(POLL);
    expect(anaBuild.done).toBe(false);
    expect(boTests.done).toBe(false);

    loadSource.set(4);
    await time.step(POLL);
    expect(anaBuild.done).toBe(true);
    expectNoDecision(anaBuild.value);
    expect(queue.runningCount()).toBe(1);
    // One at a time: the slot is Ana's until her build finishes.
    await time.step(POLL);
    expect(boTests.done).toBe(false);

    await call(anaHooks.afterCall, finished('ana-1', 'PostToolUse'));
    await time.step(POLL);
    expect(boTests.done).toBe(true);
    expectNoDecision(boTests.value);
    await call(boHooks.afterCall, finished('bo-1', 'PostToolUseFailure'));
    expect(queue.runningCount()).toBe(0);
  });

  it('says the place again every minute, keeps the turn alive, and names the chat only to the person', async () => {
    const { gate, time } = machine(20);
    const ana = chat('sdk-ana');
    const hooks = hooksFor(ana, gate, time.now);
    track(call(hooks.wait, bash('npx tsc --noEmit -p apps/secret-project', 'ana-1')));
    await settle();
    // Who the job is for is in the person's own list, never in the folder or the chat's words.
    expect(gate.waitingJobs()).toMatchObject([{ job: 'tsc', chatId: 'sdk-ana', agentName: 'Ana' }]);
    // A live turn takes each notice off the queue as it comes.
    const delivered = ana.eventQueue.splice(0);
    await time.step(MINUTE);
    expect(said(ana)).toHaveLength(1);
    delivered.push(...ana.eventQueue.splice(0));
    expect(delivered).toHaveLength(2);
    expect(ana.eventQueueNotify).toHaveBeenCalledTimes(2);
    expect(ana.lastActivity).toBe(time.now());
    expect(JSON.stringify(delivered)).not.toMatch(/secret-project|tsc|Ana/);
  });

  it('keeps one notice on the queue, the latest, while no turn reads it', async () => {
    settings.maxWaitMinutes = 2;
    const { gate, time } = machine(20);
    const ana = chat('sdk-ana');
    const other: StreamEvent = { type: 'system_status', data: { message: 'Running hook "x"…' } };
    ana.eventQueue.push(other);
    const hooks = hooksFor(ana, gate, time.now);
    track(call(hooks.wait, bash('pnpm build', 'ana-1')));
    await settle();
    for (let minute = 0; minute < 3; minute += 1) await time.step(MINUTE);
    // The other event stays where it was; the wait's four notices are one, the newest.
    expect(ana.eventQueue).toHaveLength(2);
    expect(ana.eventQueue[0]).toBe(other);
    expect(ana.eventQueue[1]).toMatchObject({
      data: {
        status: LOAD_WAIT_STATUS,
        message: 'Still waiting for the computer. Next in line. It runs anyway in about 4h.',
      },
    });
    expect(ana.eventQueueNotify).toHaveBeenCalledTimes(4);
  });
});

describe('one thread at a time: a thread’s own heavy calls share its turn', () => {
  it('two heavy calls in one batch share one ticket, then one slot, and nobody deadlocks', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const ana = chat('sdk-ana');
    const anaHooks = hooksFor(ana, gate, time.now);
    const boHooks = hooksFor(chat('sdk-bo'), gate, time.now);
    // The CLI may wait for every hook in a batch before it runs any of the calls.
    const batch = track(
      Promise.all([
        call(anaHooks.wait, bash('pnpm build', 'ana-1')),
        call(anaHooks.wait, bash('pnpm test', 'ana-2')),
      ])
    );
    const boLint = track(call(boHooks.wait, bash('pnpm lint', 'bo-1')));
    await settle();
    // Ana's two calls hold one place in line between them, ahead of Bo's, and say so once.
    expect(gate.waitingJobs().map((job) => job.chatId)).toEqual(['sdk-ana', 'sdk-bo']);
    expect(said(ana)).toEqual(['Waiting for the computer to calm down. Next in line.']);

    loadSource.set(4);
    await time.step(POLL);
    // Both of Ana's hooks returned on the one slot, before either call ran: no deadlock.
    expect(batch.done).toBe(true);
    for (const answer of batch.value!) expectNoDecision(answer);
    expect(queue.runningCount()).toBe(1);
    expect(boLint.done).toBe(false);

    // The slot is Ana's until the last of her calls ends.
    await call(anaHooks.afterCall, finished('ana-1', 'PostToolUse'));
    await time.step(POLL);
    expect(queue.runningCount()).toBe(1);
    expect(boLint.done).toBe(false);
    await call(anaHooks.afterCall, finished('ana-2', 'PostToolUseFailure'));
    await time.step(POLL);
    expect(boLint.done).toBe(true);
    expectNoDecision(boLint.value);
    await call(boHooks.afterCall, finished('bo-1', 'PostToolUse'));
    expect(queue.runningCount()).toBe(0);
  });

  it('a heavy call from a chat that already holds the slot goes on at once, even on a busy computer', async () => {
    const { gate, time, loadSource, queue } = machine(4);
    const anaHooks = hooksFor(chat('sdk-ana'), gate, time.now);
    const boHooks = hooksFor(chat('sdk-bo'), gate, time.now);
    await call(anaHooks.wait, bash('pnpm build', 'ana-1'));
    loadSource.set(20);
    const boBuild = track(call(boHooks.wait, bash('pnpm build', 'bo-1')));
    expectNoDecision(await call(anaHooks.wait, bash('pnpm test', 'ana-2')));
    await settle();
    // Still one slot, Ana's, and Bo still waits behind it.
    expect(queue.runningCount()).toBe(1);
    expect(boBuild.done).toBe(false);
    await call(anaHooks.afterCall, finished('ana-2', 'PostToolUse'));
    await call(anaHooks.afterCall, finished('ana-1', 'PostToolUse'));
    expect(queue.runningCount()).toBe(0);
  });

  // Security, DOR-4209: the share key is the server's own launch identity. A call that names
  // another chat, in its input or its command, cannot join that chat's slot.
  it('a call that names another chat cannot join that chat’s slot', async () => {
    const { gate, time, loadSource, queue } = machine(4);
    const anaHooks = hooksFor(chat('sdk-ana'), gate, time.now);
    const boHooks = hooksFor(chat('sdk-bo'), gate, time.now);
    await call(boHooks.wait, bash('pnpm build', 'bo-1'));
    loadSource.set(20);
    const forged = {
      ...bash('pnpm build', 'ana-1'),
      session_id: 'sdk-bo',
      tool_input: {
        command: 'pnpm build',
        chatId: 'sdk-bo',
        shareKey: 'claude-code:sdk-bo:main',
      },
    } as HookInput;
    const anaBuild = track(call(anaHooks.wait, forged));
    await settle();
    // Bo still holds the one slot; Ana took her own place in line behind it.
    expect(queue.runningCount()).toBe(1);
    expect(anaBuild.done).toBe(false);
    expect(gate.waitingJobs().map((job) => job.chatId)).toEqual(['sdk-ana']);

    await call(boHooks.afterCall, finished('bo-1', 'PostToolUse'));
    loadSource.set(4);
    await time.step(POLL);
    expect(anaBuild.done).toBe(true);
    expectNoDecision(anaBuild.value);
    await call(anaHooks.afterCall, finished('ana-1', 'PostToolUse'));
    expect(queue.runningCount()).toBe(0);
  });

  it('a chat’s helpers running side by side take their turns one after the other', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const hooks = hooksFor(chat('sdk-ana'), gate, time.now);
    const first = track(call(hooks.wait, bash('pnpm build', 'h1-1', 'helper-1')));
    const second = track(call(hooks.wait, bash('pnpm test', 'h2-1', 'helper-2')));
    await settle();
    // Two places in line, one per helper, both the same chat on the person's list.
    expect(gate.waitingJobs().map((job) => job.chatId)).toEqual(['sdk-ana', 'sdk-ana']);

    loadSource.set(4);
    await time.step(POLL);
    expect(first.done).toBe(true);
    expect(second.done).toBe(false);
    // The first helper's slot does not carry the second: it waits until the first is done.
    await time.step(POLL);
    expect(second.done).toBe(false);
    await call(hooks.afterCall, finished('h1-1', 'PostToolUse'));
    await time.step(POLL);
    expect(second.done).toBe(true);
    expectNoDecision(second.value);
    expect(queue.runningCount()).toBe(1);
    await call(hooks.afterCall, finished('h2-1', 'PostToolUse'));
    expect(queue.runningCount()).toBe(0);
  });

  it('a busy helper’s slot is not the main thread’s: the main thread’s batch takes its own turn and shares it', async () => {
    const { gate, time, loadSource, queue } = machine(4);
    const hooks = hooksFor(chat('sdk-ana'), gate, time.now);
    await call(hooks.wait, bash('pnpm build', 'h1-1', 'helper-1'));
    loadSource.set(20);
    const batch = track(
      Promise.all([
        call(hooks.wait, bash('pnpm lint', 'main-1')),
        call(hooks.wait, bash('pnpm test', 'main-2')),
      ])
    );
    await settle();
    // The main thread waits behind its own helper, in one place in line for both calls.
    expect(batch.done).toBe(false);
    expect(queue.list()).toHaveLength(1);
    await call(hooks.afterCall, finished('h1-1', 'PostToolUse'));
    loadSource.set(4);
    await time.step(POLL);
    expect(batch.done).toBe(true);
    for (const answer of batch.value!) expectNoDecision(answer);
    expect(queue.runningCount()).toBe(1);
    await call(hooks.afterCall, finished('main-1', 'PostToolUse'));
    expect(queue.runningCount()).toBe(1);
    await call(hooks.afterCall, finished('main-2', 'PostToolUse'));
    expect(queue.runningCount()).toBe(0);
  });

  it('a call that leaves a shared place in line keeps the ticket for the other; the last one out takes it', async () => {
    const { gate, time, queue } = machine(20);
    const hooks = hooksFor(chat('sdk-ana'), gate, time.now);
    const cancel = new AbortController();
    const first = track(call(hooks.wait, bash('pnpm build', 'ana-1'), cancel.signal));
    const second = track(call(hooks.wait, bash('pnpm test', 'ana-2')));
    await settle();
    expect(queue.list()).toHaveLength(1);
    // The CLI cancels the first call's hook: the second keeps the chat's place.
    cancel.abort();
    await settle();
    expectNoDecision(first.value);
    expect(second.done).toBe(false);
    expect(queue.list()).toHaveLength(1);
    // A card goes up for the second: the last call out takes the ticket with it.
    hooks.releaseCall('ana-2');
    await settle();
    expectNoDecision(second.value);
    expect(queue.list()).toHaveLength(0);
    expect(queue.runningCount()).toBe(0);
  });
});

describe('the place in line, in words', () => {
  const at = (position: number, waitedMs = 0, pastMaxWait = false) => ({
    position,
    aheadCount: position - 1,
    load: 20,
    maxLoad: 16,
    waitedMs,
    pastMaxWait,
  });

  it('gives the place alone, with English ordinals', () => {
    expect(loadWaitMessage(at(1), undefined)).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    const places = [2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) =>
      loadWaitMessage(at(n), undefined).replace('Waiting for the computer to calm down. ', '')
    );
    expect(places).toEqual([
      '2nd in line.',
      '3rd in line.',
      '4th in line.',
      '11th in line.',
      '12th in line.',
      '13th in line.',
      '21st in line.',
      '22nd in line.',
      '23rd in line.',
      '101st in line.',
      '111th in line.',
    ]);
  });

  it('says when a long wait will end anyway, past maxWaitMinutes', () => {
    expect(loadWaitMessage(at(2, 60 * MINUTE, true), 240 * MINUTE)).toBe(
      'Still waiting for the computer. 2nd in line. It runs anyway in about 3h.'
    );
    expect(loadWaitMessage(at(1, 200 * MINUTE, true), 240 * MINUTE)).toBe(
      'Still waiting for the computer. Next in line. It runs anyway in about 40m.'
    );
    expect(loadWaitMessage(at(1, 60 * MINUTE, true), undefined)).toBe(
      'Still waiting for the computer. Next in line.'
    );
  });

  it('keeps every message within the app’s fifteen-word limit', () => {
    const longest = loadWaitMessage(at(111, 61 * MINUTE, true), 600 * MINUTE);
    expect(longest.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});

describe('the gate holds a call and never decides it', () => {
  let root: string;
  let roots: ShellGuardRoots;
  let agent: string;
  /** The shell guard's own check, in this process. */
  const check: ShellChecker = async (command, where, reads) => ({
    outcome: 'checked',
    ...(await checkShellCommand(command, where, reads)),
  });

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'load-gate-guard-')));
    agent = path.join(root, 'data', 'agents', 'ana');
    fs.mkdirSync(path.join(agent, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(agent, '.claude', 'settings.json'), '{}');
    for (const folder of ['work', 'home', 'account']) {
      fs.mkdirSync(path.join(root, folder), { recursive: true });
    }
    roots = {
      cwd: path.join(root, 'work'),
      dorkHome: path.join(root, 'data'),
      home: path.join(root, 'home'),
      accounts: [path.join(root, 'account')],
      env: { HOME: path.join(root, 'home') },
      agentHomes: () => [agent],
    };
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function guardFor(session: { permissionMode: PermissionModeId }) {
    return createShellPathGuardHook(session, {
      roots: () => roots,
      check,
      recordRefusal: vi.fn(),
      log: { info: () => {}, warn: () => {} },
    });
  }

  it('a heavy command the shell guard refuses is still refused once its slot comes, and gives the slot back', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const session = { ...chat('sdk-ana'), permissionMode: 'bypassPermissions' as PermissionModeId };
    const hooks = hooksFor(session, gate, time.now);
    const command = `pnpm build && echo x > ${agent}/.claude/settings.json`;
    const settled = track(
      cliSettles([guardFor(session), hooks.wait.hooks[0]!], bash(command, 'c-1'), 'c-1')
    );
    await settle();
    // Held: the CLI waits for every hook, the gate's included.
    expect(settled.done).toBe(false);

    loadSource.set(4);
    await time.step(POLL);
    expect(settled.done).toBe(true);
    expect(settled.value).toMatchObject({ decision: 'deny', reason: SHELL_WRITE_DENY_REASON });
    expectNoDecision(settled.value!.answers[1]);
    // The refused call never runs, so no PostToolUse comes; its batch ending gives the slot back.
    expect(queue.runningCount()).toBe(1);
    await call(hooks.backstops.PostToolBatch[0]!, {
      ...BASE,
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Bash', tool_input: { command }, tool_use_id: 'c-1' }],
    } as HookInput);
    expect(queue.runningCount()).toBe(0);
  });

  /**
   * A chat below Full whose heavy `git push` waits for its slot on a busy computer, then, once the
   * computer calms, goes on to the permission flow, which raises a card with the launch's own
   * `releaseCall` wired in, as `launch-resolver.ts` wires it.
   */
  async function carded(m: ReturnType<typeof machine>, cardClock: 'real' | 'fake' = 'real') {
    const session = {
      ...chat('sdk-ana'),
      permissionMode: 'acceptEdits' as PermissionModeId,
      turnPermissionCeiling: 'runtime-default' as const,
      cwd: roots.cwd,
      pendingInteractions: new Map<string, PendingInteraction>(),
    };
    const hooks = hooksFor(session, m.gate, m.time.now);
    const settled = track(
      cliSettles([guardFor(session), hooks.wait.hooks[0]!], bash('git push', 'card'), 'card')
    );
    await settle();
    expect(settled.done).toBe(false);
    m.loadSource.set(4);
    await m.time.step(POLL);
    // No hook decided, the gate least of all, so the call goes on to the permission flow.
    expect(settled.value?.decision).toBe('permission flow');
    expectNoDecision(settled.value!.answers[1]);
    expect(m.queue.runningCount()).toBe(1);
    const cancel = new AbortController();
    const context: ToolApprovalContext = { signal: cancel.signal, toolUseID: 'card' };
    // The card's own wait timers, faked only for a test that runs the card out of time.
    if (cardClock === 'fake') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const canUseTool = createCanUseTool(
      session,
      noopLog,
      undefined,
      undefined,
      undefined,
      undefined,
      hooks.releaseCall
    );
    const answer = track(canUseTool('Bash', { command: 'git push' }, context));
    await vi.waitFor(() => expect(session.pendingInteractions.has('card')).toBe(true));
    expect(session.eventQueue.map((event) => event.type)).toContain('approval_required');
    /** The person answers the card. */
    const answerCard = (yes: boolean): void => {
      const pending = session.pendingInteractions.get('card');
      if (pending?.type !== 'approval') throw new Error('no card is waiting');
      pending.resolve(yes, yes ? undefined : 'Not now.');
    };
    return { hooks, answer, answerCard, cancel };
  }

  it('a heavy command that needs a card reaches the card, gives its slot back while it waits, and runs at once on a yes', async () => {
    const m = machine(20);
    const { hooks, answer, answerCard } = await carded(m);
    // The card took the slot back: the line is free for the next heavy job.
    expect(m.queue.runningCount()).toBe(0);
    const bo = hooksFor(chat('sdk-bo'), m.gate, m.time.now);
    const boBuild = track(call(bo.wait, bash('pnpm build', 'bo-1')));
    await settle();
    expect(boBuild.done).toBe(true);
    expect(m.queue.runningCount()).toBe(1);

    // The person approves: the call runs now, outside the line, and takes no slot or ticket. At
    // most one job runs outside the line this way, the one the person said yes to.
    answerCard(true);
    await settle();
    expect(answer.value).toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } });
    expect(m.queue.runningCount()).toBe(1);
    expect(m.queue.list()).toHaveLength(0);
    // Its finishing gives back nothing it does not hold: Bo's slot stays Bo's.
    expectNoDecision(await call(hooks.afterCall, finished('card', 'PostToolUse')));
    expect(m.queue.runningCount()).toBe(1);
    await call(bo.afterCall, finished('bo-1', 'PostToolUse'));
    expect(m.queue.runningCount()).toBe(0);
  });

  describe('however the card ends, the slot was freed when it was raised and nothing is retaken', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    type Card = Awaited<ReturnType<typeof carded>>;
    const ENDINGS: [string, 'allow' | 'deny', 'real' | 'fake', (card: Card) => void][] = [
      ['approved', 'allow', 'real', (card) => card.answerCard(true)],
      ['denied', 'deny', 'real', (card) => card.answerCard(false)],
      [
        'run out of time',
        'deny',
        'fake',
        // The interaction wait's own path: it parks, then expires at the ceiling.
        () => {
          vi.advanceTimersByTime(SESSIONS.INTERACTION_PARK_CEILING_MS);
        },
      ],
      ['withdrawn by the CLI', 'deny', 'real', (card) => card.cancel.abort()],
    ];

    it.each(ENDINGS)('%s', async (_ending, behavior, cardClock, end) => {
      const m = machine(20);
      const card = await carded(m, cardClock);
      // Freed the moment the card went up, before anyone answered.
      expect(m.queue.runningCount()).toBe(0);
      expect(m.queue.list()).toHaveLength(0);
      end(card);
      await settle();
      expect(card.answer.value).toMatchObject({ behavior });
      // Nothing retaken, whatever the ending, and nothing left in line.
      expect(m.queue.runningCount()).toBe(0);
      expect(m.queue.list()).toHaveLength(0);
      // Every hook the call can still meet answers nothing, and frees nothing it does not hold.
      const after: HookInput[] = [
        finished('card', behavior === 'allow' ? 'PostToolUse' : 'PostToolUseFailure'),
        {
          ...BASE,
          hook_event_name: 'PermissionDenied',
          tool_name: 'Bash',
          tool_input: {},
          tool_use_id: 'card',
          reason: 'denied',
        } as HookInput,
        { ...BASE, hook_event_name: 'Stop', stop_hook_active: false } as HookInput,
      ];
      for (const input of after) {
        expectNoDecision(await call(card.hooks.afterCall, input));
        expectNoDecision(await call(card.hooks.sweep, input));
      }
      expect(m.queue.runningCount()).toBe(0);
    });
  });

  it.each(['the CLI cancels the hook', 'the process ends'] as const)(
    'a turn stopped while its call waits in line: %s, its ticket leaves, and the next job moves up',
    async (how) => {
      const { gate, time, loadSource, queue } = machine(20);
      const ana = chat('sdk-ana');
      const bo = chat('sdk-bo');
      const anaHooks = hooksFor(ana, gate, time.now);
      const boHooks = hooksFor(bo, gate, time.now);
      const cancel = new AbortController();
      const anaBuild = track(call(anaHooks.wait, bash('pnpm build', 'ana-1'), cancel.signal));
      const boTests = track(call(boHooks.wait, bash('pnpm test', 'bo-1')));
      await settle();
      expect(said(bo)).toEqual(['Waiting for the computer to calm down. 2nd in line.']);

      // Stop pressed on Ana's chat. An interrupt runs no Stop hook, so the stop arrives either as
      // the CLI cancelling the waiting hook or as the process going away.
      if (how === 'the CLI cancels the hook') cancel.abort();
      else releaseHeavyJobsOf({ hooks: { PreToolUse: [anaHooks.wait] } });
      await settle();
      // Ana's call fails open into the normal flow (the CLI stops it there), and leaves the line.
      expectNoDecision(anaBuild.value);
      expect(queue.list()).toHaveLength(1);
      expect(anaHooks.log.warn).not.toHaveBeenCalled();

      // Bo moved up: next in line now, and first to run once the computer calms.
      bo.eventQueue.splice(0);
      await time.step(MINUTE);
      expect(said(bo)).toEqual(['Waiting for the computer to calm down. Next in line.']);
      loadSource.set(4);
      await time.step(POLL);
      expectNoDecision(boTests.value);
      expect(queue.runningCount()).toBe(1);
      await call(boHooks.afterCall, finished('bo-1', 'PostToolUse'));
      expect(queue.runningCount()).toBe(0);
    }
  );

  it('canUseTool tells the launch only of a call put to a person', async () => {
    const onCard = vi.fn();
    const full = {
      permissionMode: 'bypassPermissions' as PermissionModeId,
      cwd: roots.cwd,
      pendingInteractions: new Map<string, PendingInteraction>(),
      eventQueue: [] as StreamEvent[],
      eventQueueNotify: vi.fn(),
    };
    const canUseTool = createCanUseTool(
      full,
      noopLog,
      undefined,
      undefined,
      undefined,
      undefined,
      onCard
    );
    const context: ToolApprovalContext = { signal: new AbortController().signal, toolUseID: 'f' };
    expect(await canUseTool('Bash', { command: 'pnpm build' }, context)).toMatchObject({
      behavior: 'allow',
    });
    expect(onCard).not.toHaveBeenCalled();
  });

  it('a card for a call still in line takes its ticket out, and it never runs from the line', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const hooks = hooksFor(chat('s'), gate, time.now);
    const held = track(call(hooks.wait, bash('pnpm build', 'still-waiting')));
    await settle();
    expect(queue.list()).toHaveLength(1);
    // The CLI gave up on the hook and asked a person about the call.
    hooks.releaseCall('still-waiting');
    await settle();
    expectNoDecision(held.value);
    expect(queue.list()).toHaveLength(0);
    loadSource.set(4);
    await time.step(POLL);
    expect(queue.runningCount()).toBe(0);
    expect(hooks.log.warn).not.toHaveBeenCalled();
  });
});

describe('every answer is no answer', () => {
  function stubSlot(outcome: WaitOutcome): HeldSlot {
    return { waitedMs: 0, outcome, heartbeat: () => true, release: vi.fn() };
  }
  /** A gate whose `gateIfHeavy` the test writes; the hook calls nothing else. */
  function stubGate(gateIfHeavy: LoadGate['gateIfHeavy']): LoadGate {
    return { waitForSlot: vi.fn(), gateIfHeavy, waitingJobs: () => [] };
  }
  const clock = () => 0;

  it.each(['ran', 'let-through', 'hard-cap', 'gate-error'] as const)(
    'after a %s slot',
    async (outcome) => {
      const slot = stubSlot(outcome);
      const hooks = hooksFor(
        chat('s'),
        stubGate(async () => slot),
        clock
      );
      expectNoDecision(await call(hooks.wait, bash('pnpm verify', 't-1')));
      expectNoDecision(await call(hooks.afterCall, finished('t-1', 'PostToolUse')));
      expect(slot.release).toHaveBeenCalledTimes(1);
    }
  );

  it('hands the gate the very command the shell guard reads, so the two cannot read it apart', async () => {
    const gateIfHeavy = vi.fn(async () => null);
    const hooks = hooksFor(chat('sdk-ana'), stubGate(gateIfHeavy), clock);
    expectNoDecision(await call(hooks.wait, bash('FOO=1 nice pnpm -C web build', 't-1')));
    expect(gateIfHeavy).toHaveBeenCalledWith(
      'FOO=1 nice pnpm -C web build',
      { chatId: 'sdk-ana', agentName: 'Ana', shareKey: 'claude-code:sdk-ana:main' },
      expect.objectContaining({ signal: expect.any(AbortSignal), onWait: expect.any(Function) })
    );
  });

  it('for a light command, a disabled gate, another tool and a call with no command', async () => {
    const { gate, time, queue } = machine(20);
    const gateIfHeavy = vi.spyOn(gate, 'gateIfHeavy');
    const hooks = hooksFor(chat('s'), gate, time.now);
    expectNoDecision(await call(hooks.wait, bash('git status && ls', 't-1')));
    settings.enabled = false;
    expectNoDecision(await call(hooks.wait, bash('pnpm build', 't-2')));
    // Neither took a ticket.
    expect(queue.list()).toHaveLength(0);
    expect(queue.runningCount()).toBe(0);
    gateIfHeavy.mockClear();
    expectNoDecision(
      await call(hooks.wait, {
        ...BASE,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/work/a' },
        tool_use_id: 't-3',
      } as HookInput)
    );
    expectNoDecision(
      await call(hooks.wait, {
        ...BASE,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
        tool_use_id: 't-4',
      } as HookInput)
    );
    expect(gateIfHeavy).not.toHaveBeenCalled();
  });

  it('when the gate breaks, naming no command and no message in the log', async () => {
    const hooks = hooksFor(
      chat('s'),
      stubGate(async () => {
        throw new Error('EACCES /Users/someone/secret-project');
      }),
      clock
    );
    expectNoDecision(await call(hooks.wait, bash('pnpm build --filter secret-project', 't-1')));
    expect(hooks.log.warn).toHaveBeenCalledWith(expect.any(String), { error: 'Error' });
    expect(JSON.stringify(hooks.log.warn.mock.calls)).not.toMatch(/secret-project/);
  });

  it('when the settings cannot be read: the shipped time limit, and the gate still asked', async () => {
    const slot = stubSlot('ran');
    const gateIfHeavy = vi.fn(async () => slot);
    const hooks = hooksFor(chat('s'), stubGate(gateIfHeavy), clock, {
      settings: () => {
        throw new Error('config not loaded');
      },
    });
    expect(hooks.wait.timeout).toBe(loadGateHookTimeoutSeconds(null));
    expectNoDecision(await call(hooks.wait, bash('pnpm build', 't-1')));
    expect(gateIfHeavy).toHaveBeenCalledTimes(1);
  });

  it('when a Stop ends the wait: the ticket leaves the line', async () => {
    const { gate, time, queue } = machine(20);
    const hooks = hooksFor(chat('s'), gate, time.now);
    const stop = new AbortController();
    const answer = track(call(hooks.wait, bash('make', 't-1'), stop.signal));
    await settle();
    expect(queue.list()).toHaveLength(1);
    stop.abort();
    await settle();
    expectNoDecision(answer.value);
    expect(queue.list()).toHaveLength(0);
    expect(hooks.log.warn).not.toHaveBeenCalled();
  });

  it('when the CLI’s own time limit passes first: the call goes on, and the log says why', async () => {
    settings.hardCapMinutes = 1;
    settings.maxWaitMinutes = 1;
    const { gate, time, queue } = machine(20);
    const hooks = hooksFor(chat('s'), gate, time.now);
    expect(hooks.wait.timeout).toBe(loadGateHookTimeoutSeconds(settings));
    // The cap is raised after the launch, past the time limit the CLI was given.
    settings.hardCapMinutes = 600;
    settings.maxWaitMinutes = 600;
    const cancel = new AbortController();
    const answer = track(call(hooks.wait, bash('cargo build', 't-1'), cancel.signal));
    await settle();
    await time.step(hooks.wait.timeout! * 1_000);
    cancel.abort();
    await settle();
    expectNoDecision(answer.value);
    expect(hooks.log.warn).toHaveBeenCalledWith(expect.stringContaining('time limit'), {});
    expect(queue.list()).toHaveLength(0);
  });

  it('when a person lets it through, or the hard cap passes, on the real line', async () => {
    settings.maxWaitMinutes = 1;
    settings.hardCapMinutes = 1;
    const { gate, time, queue, lines } = machine(20);
    const hooks = hooksFor(chat('s'), gate, time.now);
    const capped = track(call(hooks.wait, bash('pnpm install', 'cap')));
    await settle();
    await time.step(MINUTE);
    expectNoDecision(capped.value);
    await call(hooks.afterCall, finished('cap', 'PostToolUse'));

    settings.maxWaitMinutes = 60;
    settings.hardCapMinutes = 240;
    const waiting = track(call(hooks.wait, bash('docker build -t secret-image .', 'let')));
    await settle();
    queue.markLetThrough(gate.waitingJobs()[0]!.id);
    await time.step(POLL);
    expectNoDecision(waiting.value);
    await call(hooks.afterCall, finished('let', 'PostToolUse'));
    expect(queue.runningCount()).toBe(0);
    // One line each, by program name alone.
    expect(lines).toEqual([
      '[LoadGate] A pnpm job ran after waiting 1 min, the hard cap',
      '[LoadGate] A docker job was let through',
    ]);
  });

  it('from every hook that gives a slot back', async () => {
    const hooks = hooksFor(
      chat('s'),
      stubGate(async () => stubSlot('ran')),
      clock
    );
    const events: HookInput[] = [
      finished('t-1', 'PostToolUse'),
      finished('t-1', 'PostToolUseFailure'),
      { ...BASE, hook_event_name: 'PostToolBatch', tool_calls: [] } as HookInput,
      {
        ...BASE,
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: {},
        tool_use_id: 't-1',
        reason: 'denied',
      } as HookInput,
      { ...BASE, hook_event_name: 'Stop', stop_hook_active: false } as HookInput,
      { ...BASE, hook_event_name: 'SubagentStop', agent_id: 'h-1' } as HookInput,
      { ...BASE, hook_event_name: 'SessionEnd', reason: 'other' } as HookInput,
    ];
    for (const event of events) {
      expectNoDecision(await call(hooks.afterCall, event));
      expectNoDecision(await call(hooks.sweep, event));
    }
  });
});

describe('giving slots back', () => {
  it('gives back a slot granted after its call already ended', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const hooks = hooksFor(chat('s'), gate, time.now);
    const answer = track(call(hooks.wait, bash('pnpm lint', 'late')));
    await settle();
    // The CLI stopped waiting without cancelling, and the call ran and finished.
    await call(hooks.afterCall, finished('late', 'PostToolUse'));
    loadSource.set(4);
    await time.step(POLL);
    expectNoDecision(answer.value);
    expect(queue.runningCount()).toBe(0);
  });

  it('at turn end for the main thread, and at a helper’s end for the helper’s', async () => {
    settings.slots = 2;
    const { gate, time, queue } = machine(4);
    const hooks = hooksFor(chat('s'), gate, time.now);
    await call(hooks.wait, bash('pnpm build', 'main'));
    // A helper is its own thread: it takes its own slot rather than riding the main thread's.
    await call(hooks.wait, bash('pnpm test', 'helper', 'h-1'));
    expect(queue.runningCount()).toBe(2);
    await call(hooks.sweep, {
      ...BASE,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    } as HookInput);
    // The main thread's slot is back; the helper's stays until the helper ends.
    expect(queue.runningCount()).toBe(1);
    await call(hooks.backstops.SubagentStop[0]!, {
      ...BASE,
      hook_event_name: 'SubagentStop',
      agent_id: 'h-1',
    } as HookInput);
    expect(queue.runningCount()).toBe(0);
  });

  it('when the session ends', async () => {
    const { gate, time, queue } = machine(4);
    const hooks = hooksFor(chat('s'), gate, time.now);
    await call(hooks.wait, bash('pnpm build', 'main', 'h-2'));
    expect(queue.runningCount()).toBe(1);
    await call(hooks.backstops.SessionEnd[0]!, {
      ...BASE,
      hook_event_name: 'SessionEnd',
      reason: 'other',
    } as HookInput);
    expect(queue.runningCount()).toBe(0);
  });

  it('when the process ends mid-job: the slot is free, waits stop, and no hook has to run', async () => {
    const { gate, time, loadSource, queue } = machine(4);
    const hooks = hooksFor(chat('s'), gate, time.now);
    // A process launched with these hooks, running a build.
    const options = { hooks: { PreToolUse: [{ hooks: [] }, hooks.wait] } };
    await call(hooks.wait, bash('pnpm build', 'running'));
    expect(queue.runningCount()).toBe(1);
    // It crashed, or was closed, or a Stop escalated to a kill: no PostToolUse, no SessionEnd.
    releaseHeavyJobsOf(options);
    expect(queue.runningCount()).toBe(0);
    // And a process that ends while its call is still in line takes the ticket out with it.
    loadSource.set(20);
    const waiting = track(call(hooks.wait, bash('pnpm test', 'waiting')));
    await settle();
    expect(queue.list()).toHaveLength(1);
    releaseHeavyJobsOf(options);
    await settle();
    expect(queue.list()).toHaveLength(0);
    expectNoDecision(waiting.value);
    // Options with no load-gate hook, or none at all, are left alone.
    releaseHeavyJobsOf({ hooks: { PreToolUse: [{ hooks: [] }] } });
    releaseHeavyJobsOf({});
  });

  it('an old process’s late exit frees only its own slots, never its replacement’s', async () => {
    const { gate, time, queue } = machine(4);
    const hooks = hooksFor(chat('s'), gate, time.now);
    const options = { hooks: { PreToolUse: [hooks.wait] } };
    // The first process, holding a build.
    const oldExited = startHeavyJobsProcess(options);
    await call(hooks.wait, bash('pnpm build', 'old-1'));
    // A recovery boots a replacement from the same plan before the old one's exit lands; its job
    // is the same chat's, so it shares the chat's slot. Another chat's job waits behind it.
    const newExited = startHeavyJobsProcess(options);
    await call(hooks.wait, bash('pnpm test', 'new-1'));
    expect(queue.runningCount()).toBe(1);
    const other = hooksFor(chat('sdk-other'), gate, time.now);
    const behind = track(call(other.wait, bash('pnpm lint', 'other-1')));
    await settle();
    expect(behind.done).toBe(false);

    oldExited();
    await settle();
    // Only the old build's share came back; the replacement's keeps the slot, so the other chat
    // still waits.
    expect(queue.runningCount()).toBe(1);
    await time.step(POLL);
    expect(behind.done).toBe(false);

    newExited();
    await time.step(POLL);
    expect(behind.done).toBe(true);
    expectNoDecision(behind.value);
    await call(other.afterCall, finished('other-1', 'PostToolUse'));
    expect(queue.runningCount()).toBe(0);
  });

  it('after a process ends, a replacement launched with the same hooks still waits and holds', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const hooks = hooksFor(chat('s'), gate, time.now);
    hooks.releaseAll();
    // Still waits on a busy computer...
    const next = track(call(hooks.wait, bash('pnpm build', 'next-process')));
    await settle();
    expect(next.done).toBe(false);
    // ...and still holds once its turn comes.
    loadSource.set(4);
    await time.step(POLL);
    expect(next.done).toBe(true);
    expect(queue.runningCount()).toBe(1);
    await call(hooks.afterCall, finished('next-process', 'PostToolUse'));
    expect(queue.runningCount()).toBe(0);
  });

  it('keeps one slot for a call held twice', async () => {
    const first = { waitedMs: 0, outcome: 'ran' as const, heartbeat: () => true, release: vi.fn() };
    const second = { ...first, release: vi.fn() };
    const slots = [first, second];
    const hooks = hooksFor(
      chat('s'),
      {
        waitForSlot: vi.fn(),
        gateIfHeavy: async () => slots.shift()!,
        waitingJobs: () => [],
      },
      () => 0
    );
    await call(hooks.wait, bash('pnpm build', 'twice'));
    await call(hooks.wait, bash('pnpm build', 'twice'));
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.release).not.toHaveBeenCalled();
    await call(hooks.afterCall, finished('twice', 'PostToolUse'));
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it('when a permission is refused for the call', async () => {
    const { gate, time, queue } = machine(4);
    const hooks = hooksFor(chat('s'), gate, time.now);
    await call(hooks.wait, bash('pnpm build', 'refused'));
    expect(queue.runningCount()).toBe(1);
    await call(hooks.backstops.PermissionDenied[0]!, {
      ...BASE,
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: {},
      tool_use_id: 'refused',
      reason: 'denied',
    } as HookInput);
    expect(queue.runningCount()).toBe(0);
  });

  it('holds the shell alone, past the hard cap, never past the longest timer', () => {
    const hooks = hooksFor(chat('s'), machine().gate, Date.now);
    expect(hooks.wait.matcher).toBe(LOAD_GATE_MATCHER);
    expect(hooks.afterCall.matcher).toBe(LOAD_GATE_MATCHER);
    expect(hooks.wait.timeout).toBe(240 * 60 + 300);
    expect(loadGateHookTimeoutSeconds(null)).toBe(240 * 60 + 300);
    // A cap of a year would overflow Node's timer, which then fires at once.
    settings.hardCapMinutes = 365 * 24 * 60;
    expect(loadGateHookTimeoutSeconds(settings)).toBe(Math.floor((2 ** 31 - 1) / 1_000));
  });
});
