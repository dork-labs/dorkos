/**
 * load-gate-hook: line. Shared setup lives in `./load-gate-hook.fixtures.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { releaseHeavyJobsOf, startHeavyJobsProcess } from '../../load-gate-hook.js';
import {
  POLL,
  settings,
  settle,
  machine,
  chat,
  hooksFor,
  BASE,
  bash,
  finished,
  call,
  track,
  said,
  expectNoDecision,
} from './load-gate-hook.fixtures.js';

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
});

describe('giving slots back', () => {
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
});
