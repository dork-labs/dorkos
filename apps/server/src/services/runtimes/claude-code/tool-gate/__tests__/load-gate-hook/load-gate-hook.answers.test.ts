/**
 * load-gate-hook: answers. Shared setup lives in `./load-gate-hook.fixtures.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  type HeldSlot,
  type LoadGate,
  type WaitOutcome,
} from '../../../../../core/load-gate/load-gate.js';
import {
  MINUTE,
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
  expectNoDecision,
} from './load-gate-hook.fixtures.js';

describe('every answer is no answer', () => {
  function stubSlot(outcome: WaitOutcome): HeldSlot {
    return { waitedMs: 0, outcome, heartbeat: () => true, release: vi.fn() };
  }
  /** A gate whose `gateIfHeavy` the test writes; the hook calls nothing else. */
  function stubGate(gateIfHeavy: LoadGate['gateIfHeavy']): LoadGate {
    return {
      waitForSlot: vi.fn(),
      gateIfHeavy,
      occupy: vi.fn(() => null),
      waitWhileBusy: vi.fn(async () => {}),
      waitingJobs: () => [],
      letThrough: () => 'not-found',
      markUrgent: () => 'not-found',
      moveToFront: () => 'not-found',
    };
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
