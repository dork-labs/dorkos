/**
 * Shared setup for the load-gate-hook tests, split from one file by subject.
 *
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
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import { LOAD_WAIT_STATUS } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { createLoadGate, type LoadGate } from '../../../../../core/load-gate/load-gate.js';
import { fixedLoadSource } from '../../../../../core/load-gate/load-source.js';
import { TicketQueue } from '../../../../../core/load-gate/ticket-queue.js';
import {
  loadGateHooks,
  type LoadGateHookDeps,
  type LoadGateHookSession,
} from '../../load-gate-hook.js';

export const MINUTE = 60_000;

export const POLL = 5_000;

export const noopLog = { debug: () => {}, info: () => {} };

export let dir: string;

export let settings: LoadGateSettings;

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
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock and a sleep that only move when the test says (the same shape as the gate's own tests). */
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
export function machine(load = 20) {
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
export function chat(sdkSessionId: string): LoadGateHookSession {
  return {
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
    lastActivity: 0,
    sdkSessionId,
  };
}

/** One launch's hooks for `session`, on `gate`. */
export function hooksFor(
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

export const BASE = { session_id: 's', transcript_path: '/tmp/t.jsonl', cwd: '/work' };

/** Shared helper for the load-gate-hook tests: `bash`. */
export function bash(command: string, toolUseId: string, agentId?: string): HookInput {
  return {
    ...BASE,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: toolUseId,
    ...(agentId ? { agent_id: agentId } : {}),
  } as HookInput;
}

/** Shared helper for the load-gate-hook tests: `finished`. */
export function finished(
  toolUseId: string,
  event: 'PostToolUse' | 'PostToolUseFailure'
): HookInput {
  return {
    ...BASE,
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: toolUseId,
    ...(event === 'PostToolUse' ? { tool_response: '' } : { error: 'exit 1' }),
  } as HookInput;
}

/** Shared helper for the load-gate-hook tests: `call`. */
export function call(
  matcher: HookCallbackMatcher,
  input: HookInput,
  signal: AbortSignal = new AbortController().signal
): Promise<HookJSONOutput> {
  const toolUseId = 'tool_use_id' in input ? String(input.tool_use_id) : undefined;
  return matcher.hooks[0]!(input, toolUseId, { signal });
}

/** Track a hook's answer without awaiting it. */
export function track<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
}

/** What the chat has been told about the wait, in order. */
export function said(session: LoadGateHookSession): string[] {
  return session.eventQueue.map((event) => {
    expect(event).toMatchObject({ type: 'system_status', data: { status: LOAD_WAIT_STATUS } });
    return (event.data as { message: string }).message;
  });
}

/** The rule every answer of the hook is held to: nothing at all, so the normal flow decides. */
export function expectNoDecision(answer: HookJSONOutput | undefined): void {
  expect(answer).toEqual({});
  expect(JSON.stringify(answer)).not.toMatch(/permissionDecision|"decision"|hookSpecificOutput/);
}

/**
 * How the CLI settles one call's `PreToolUse` answers, as its hook documentation states it: every
 * matching hook runs at once and the CLI waits for all of them; a deny beats an ask beats an allow;
 * a call no hook decided goes on to the permission flow. A model, kept deliberately small: what
 * matters here is that the gate's answer adds nothing to it.
 */
export async function cliSettles(hooks: HookCallback[], input: HookInput, toolUseId: string) {
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
