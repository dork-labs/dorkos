import { expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ToolContext, ToolDescriptor } from '@dorkos/doe';
import { DoeApprovals } from '../approvals.js';
import * as packageHooks from '../../shared/policy/package-hooks.js';

const COUNTDOWN_MS = 10 * 60 * 1000;
const ATTENDED_EXPIRY_MS = 4 * 60 * 60 * 1000;

const write: ToolDescriptor = {
  name: 'write',
  description: 'Write',
  schema: {},
  execute: async () => ({ content: [] }),
};
function context(signal: AbortSignal): ToolContext {
  return {
    sessionId: 's',
    callId: 'call',
    scope: 'main',
    workingDirectory: '/tmp',
    signal,
    emit: () => {},
  };
}
it('parks exact requests and accepts one answer without persisting Always Allow', async () => {
  const channel = new DoeApprovals();
  const events: StreamEvent[] = [];
  const controller = new AbortController();
  const pending = channel.callback('default', (event) => events.push(event), controller.signal)(
    write,
    {},
    context(controller.signal)
  );
  expect(events[0]?.type).toBe('approval_required');
  expect(channel.approve('wrong', true)).toBe(false);
  expect(channel.approve('call', true)).toBe(true);
  expect(await pending).toBe('allow');
  expect(channel.approve('call', true)).toBe(false);
});
it('closes approval ownership on cancellation and refuses late answers', async () => {
  const channel = new DoeApprovals();
  const controller = new AbortController();
  const events: StreamEvent[] = [];
  const pending = channel.callback('default', (event) => events.push(event), controller.signal)(
    write,
    {},
    context(controller.signal)
  );
  controller.abort();
  expect(await pending).toBe('deny');
  expect(channel.approve('call', true)).toBe(false);
  expect(events.at(-1)?.data).toEqual({ interactionId: 'call', reason: 'aborted' });
});
it('keeps the original approval when another active request repeats its call ID', async () => {
  const channel = new DoeApprovals();
  const turn = new AbortController();
  const originalRequest = new AbortController();
  const duplicateRequest = new AbortController();
  const events: StreamEvent[] = [];
  const ask = channel.callback('default', (event) => events.push(event), turn.signal);
  const original = ask(write, {}, context(originalRequest.signal));

  try {
    await expect(
      ask(write, {}, { ...context(duplicateRequest.signal), scope: 'child:helper' })
    ).resolves.toBe('deny');
    duplicateRequest.abort();
    expect(events).toMatchObject([{ type: 'approval_required', data: { toolCallId: 'call' } }]);
    expect(channel.approve('call', true)).toBe(true);
    await expect(original).resolves.toBe('allow');
    expect(events.at(-1)?.data).toEqual({ interactionId: 'call', reason: 'approved' });
    expect(channel.approve('call', true)).toBe(false);
  } finally {
    channel.close();
  }
});

it.each(['turn', 'request'] as const)(
  'refuses a shell decision if the %s ends during the package check',
  async (owner) => {
    const check = vi.spyOn(packageHooks, 'checkShellCommand').mockResolvedValue({ allowed: true });
    const channel = new DoeApprovals();
    const turn = new AbortController();
    const request = new AbortController();
    const emit = vi.fn();

    try {
      const ask = channel.callback('default', emit, turn.signal);
      const pending = ask({ ...write, name: 'shell' }, {}, context(request.signal));
      expect(check).toHaveBeenCalledOnce();
      const ending = owner === 'turn' ? turn : request;
      ending.abort();

      await expect(pending).resolves.toBe('deny');
      expect(emit).not.toHaveBeenCalled();
      expect(channel.approve('call', true)).toBe(false);
    } finally {
      channel.close();
      check.mockRestore();
    }
  }
);

it.each([
  {
    name: 'attended',
    unattended: false,
    stillPendingAt: [COUNTDOWN_MS, ATTENDED_EXPIRY_MS - 1],
    expiresAt: ATTENDED_EXPIRY_MS,
  },
  {
    name: 'unattended',
    unattended: true,
    stillPendingAt: [COUNTDOWN_MS - 1],
    expiresAt: COUNTDOWN_MS,
  },
])('uses the original $name deadline and denies exactly once', async (timing) => {
  const channel = new DoeApprovals();
  vi.useFakeTimers();
  try {
    const startedAt = Date.now();
    const turn = new AbortController();
    const request = new AbortController();
    const events: StreamEvent[] = [];
    const settled = vi.fn();
    void channel
      .callback(
        'default',
        (event) => events.push(event),
        turn.signal,
        timing.unattended
      )(write, {}, context(request.signal))
      .then(settled);

    const card = {
      type: 'approval_required',
      data: { toolCallId: 'call', startedAt, timeoutMs: COUNTDOWN_MS },
    };
    expect(events).toMatchObject([card]);
    for (const elapsed of timing.stillPendingAt) {
      await vi.advanceTimersByTimeAsync(startedAt + elapsed - Date.now());
      expect(events).toMatchObject([card]);
      expect(settled).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(startedAt + timing.expiresAt - Date.now());
    const expired = {
      type: 'interaction_cancelled',
      data: { interactionId: 'call', reason: 'timeout' },
    };
    expect(events).toMatchObject([card, expired]);
    expect(settled).toHaveBeenCalledExactlyOnceWith('deny');
    expect(channel.approve('call', true)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    turn.abort();
    request.abort();
    channel.close();
    expect(events).toMatchObject([card, expired]);
    expect(settled).toHaveBeenCalledExactlyOnceWith('deny');
  } finally {
    channel.close();
    vi.useRealTimers();
  }
});

it('accepts an attended answer after the countdown and clears its old deadline', async () => {
  const channel = new DoeApprovals();
  vi.useFakeTimers();
  try {
    const turn = new AbortController();
    const request = new AbortController();
    const events: StreamEvent[] = [];
    const pending = channel.callback('default', (event) => events.push(event), turn.signal)(
      write,
      {},
      context(request.signal)
    );

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    expect(events.map((event) => event.type)).toEqual(['approval_required']);
    expect(channel.approve('call', true)).toBe(true);
    await expect(pending).resolves.toBe('allow');
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(ATTENDED_EXPIRY_MS - COUNTDOWN_MS);
    turn.abort();
    request.abort();
    channel.close();
    expect(channel.approve('call', true)).toBe(false);
    expect(events).toMatchObject([
      { type: 'approval_required', data: { toolCallId: 'call' } },
      { type: 'interaction_cancelled', data: { interactionId: 'call', reason: 'approved' } },
    ]);
  } finally {
    channel.close();
    vi.useRealTimers();
  }
});

it('accepts a second answer for a reused call ID after the first signal and deadline', async () => {
  const channel = new DoeApprovals();
  vi.useFakeTimers();
  try {
    const turn = new AbortController();
    const originalRequest = new AbortController();
    const nextRequest = new AbortController();
    const events: StreamEvent[] = [];
    const requestApproval = channel.callback('default', (event) => events.push(event), turn.signal);
    const startedAt = Date.now();
    const original = requestApproval(write, {}, context(originalRequest.signal));

    expect(channel.approve('call', false)).toBe(true);
    await expect(original).resolves.toBe('deny');
    expect(channel.approve('call', true)).toBe(false);

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    const startedNextAt = Date.now();
    const next = requestApproval(write, {}, context(nextRequest.signal));
    const settledNext = vi.fn();
    void next.then(settledNext);

    originalRequest.abort();
    await vi.advanceTimersByTimeAsync(ATTENDED_EXPIRY_MS - COUNTDOWN_MS);
    const pendingEvents = [
      { type: 'approval_required', data: { toolCallId: 'call', startedAt } },
      { type: 'interaction_cancelled', data: { interactionId: 'call', reason: 'denied' } },
      { type: 'approval_required', data: { toolCallId: 'call', startedAt: startedNextAt } },
    ];
    expect(events).toMatchObject(pendingEvents);
    expect(settledNext).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    expect(channel.approve('call', true)).toBe(true);
    await expect(next).resolves.toBe('allow');
    expect(settledNext).toHaveBeenCalledExactlyOnceWith('allow');
    expect(channel.approve('call', true)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    expect(events).toMatchObject([
      ...pendingEvents,
      { type: 'interaction_cancelled', data: { interactionId: 'call', reason: 'approved' } },
    ]);
  } finally {
    channel.close();
    vi.useRealTimers();
  }
});

it('permits only declared reads, explicit edits and authenticated host tools without a second prompt', async () => {
  const channel = new DoeApprovals();
  const controller = new AbortController();
  const emit = vi.fn();
  expect(
    await channel.callback('acceptEdits', emit, controller.signal)(
      write,
      {},
      context(controller.signal)
    )
  ).toBe('allow');
  expect(
    await channel.callback(
      'default',
      emit,
      controller.signal,
      false,
      new Set(['memory_write'])
    )({ ...write, name: 'memory_write' }, {}, context(controller.signal))
  ).toBe('allow');
  const pending = channel.callback('default', emit, controller.signal)(
    { ...write, name: 'foreign_write' },
    {},
    context(controller.signal)
  );
  expect(emit).toHaveBeenCalledOnce();
  channel.close();
  expect(await pending).toBe('deny');
});

it('allows an ordinary edit but asks for an ordinary non-edit in Accept edits', async () => {
  const channel = new DoeApprovals();
  const controller = new AbortController();
  const events: StreamEvent[] = [];
  const approve = channel.callback('acceptEdits', (event) => events.push(event), controller.signal);
  const requestId = 'sample-summary';
  const request = { ...context(controller.signal), callId: requestId };
  try {
    const edit = approve(write, {}, request);
    expect(events).toEqual([]);
    await expect(edit).resolves.toBe('allow');

    const summary = approve({ ...write, name: 'sample_summary' }, {}, request);
    const card = {
      type: 'approval_required',
      data: { toolCallId: requestId, toolName: 'sample_summary' },
    };
    expect(events).toMatchObject([card]);
    expect(channel.approve(requestId, false)).toBe(true);
    await expect(summary).resolves.toBe('deny');
    expect(channel.approve(requestId, true)).toBe(false);
    expect(events).toMatchObject([
      card,
      { type: 'interaction_cancelled', data: { interactionId: requestId, reason: 'denied' } },
    ]);
  } finally {
    channel.close();
  }
});
