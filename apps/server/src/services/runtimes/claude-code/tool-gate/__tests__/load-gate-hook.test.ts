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
import {
  createLoadGate,
  type HeldSlot,
  type LoadGate,
  type WaitOutcome,
} from '../../../../core/load-gate/load-gate.js';
import { fixedLoadSource } from '../../../../core/load-gate/load-source.js';
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
  loadWaitMessage,
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

  it('a heavy command that needs a card still reaches the card once its slot comes', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const session = {
      ...chat('sdk-ana'),
      permissionMode: 'acceptEdits' as PermissionModeId,
      turnPermissionCeiling: 'runtime-default' as const,
      cwd: roots.cwd,
      pendingInteractions: new Map<string, PendingInteraction>(),
    };
    const hooks = hooksFor(session, gate, time.now);
    const settled = track(
      cliSettles([guardFor(session), hooks.wait.hooks[0]!], bash('git push', 'card'), 'card')
    );
    await settle();
    expect(settled.done).toBe(false);

    loadSource.set(4);
    await time.step(POLL);
    // No hook decided, the gate least of all, so the call goes on to the permission flow.
    expect(settled.value?.decision).toBe('permission flow');
    expectNoDecision(settled.value!.answers[1]);
    const context: ToolApprovalContext = {
      signal: new AbortController().signal,
      toolUseID: 'card',
    };
    void createCanUseTool(session, noopLog)('Bash', { command: 'git push' }, context);
    await vi.waitFor(() => expect(session.pendingInteractions.has('card')).toBe(true));
    expect(session.eventQueue.map((event) => event.type)).toContain('approval_required');
    // Its slot is kept while the card waits, and comes back at the latest when the turn ends.
    expect(queue.runningCount()).toBe(1);
    await call(hooks.sweep, {
      ...BASE,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    } as HookInput);
    expect(queue.runningCount()).toBe(0);
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
      { chatId: 'sdk-ana', agentName: 'Ana' },
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
      '[LoadGate] A docker job was let through by a person',
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
    await call(hooks.wait, bash('pnpm test', 'helper', 'h-1'));
    expect(queue.runningCount()).toBe(2);
    await call(hooks.sweep, {
      ...BASE,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    } as HookInput);
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
    const { gate, time, queue } = machine(4);
    const hooks = hooksFor(chat('s'), gate, time.now);
    // A process launched with these hooks, running a build, with a test suite waiting behind it.
    const options = { hooks: { PreToolUse: [{ hooks: [] }, hooks.wait] } };
    await call(hooks.wait, bash('pnpm build', 'running'));
    const behind = track(call(hooks.wait, bash('pnpm test', 'waiting')));
    await settle();
    expect(queue.runningCount()).toBe(1);
    expect(queue.list()).toHaveLength(1);
    // It crashed, or was closed, or a Stop escalated to a kill: no PostToolUse, no SessionEnd.
    releaseHeavyJobsOf(options);
    await settle();
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(0);
    expectNoDecision(behind.value);
    // Options with no load-gate hook, or none at all, are left alone.
    releaseHeavyJobsOf({ hooks: { PreToolUse: [{ hooks: [] }] } });
    releaseHeavyJobsOf({});
  });

  it('an old process’s late exit frees only its own slots, never its replacement’s', async () => {
    settings.slots = 2;
    const { gate, time, queue } = machine(4);
    const hooks = hooksFor(chat('s'), gate, time.now);
    const options = { hooks: { PreToolUse: [hooks.wait] } };
    // The first process, holding a build.
    const oldExited = startHeavyJobsProcess(options);
    await call(hooks.wait, bash('pnpm build', 'old-1'));
    // A recovery boots a replacement from the same plan before the old one's exit lands; it takes
    // the second slot, and a third job waits behind both.
    const newExited = startHeavyJobsProcess(options);
    await call(hooks.wait, bash('pnpm test', 'new-1'));
    const behind = track(call(hooks.wait, bash('pnpm lint', 'new-2')));
    await settle();
    expect(queue.runningCount()).toBe(2);

    oldExited();
    await settle();
    // Only the old build's slot came back; the replacement's job keeps its slot and its wait.
    expect(queue.runningCount()).toBe(1);
    expect(behind.done).toBe(false);
    await time.step(POLL);
    expect(behind.done).toBe(true);
    expectNoDecision(behind.value);
    expect(queue.runningCount()).toBe(2);

    newExited();
    expect(queue.runningCount()).toBe(0);
  });

  it('after a process ends, a replacement launched with the same hooks still waits and holds', async () => {
    const { gate, time, loadSource, queue } = machine(4);
    const hooks = hooksFor(chat('s'), gate, time.now);
    hooks.releaseAll();
    await call(hooks.wait, bash('pnpm build', 'next-process'));
    expect(queue.runningCount()).toBe(1);
    loadSource.set(20);
    const behind = track(call(hooks.wait, bash('pnpm test', 'behind')));
    await settle();
    expect(behind.done).toBe(false);
    await call(hooks.afterCall, finished('next-process', 'PostToolUse'));
    loadSource.set(4);
    await time.step(POLL);
    expect(behind.done).toBe(true);
    await call(hooks.afterCall, finished('behind', 'PostToolUse'));
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
