import { expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ToolContext, ToolDescriptor } from '@dorkos/doe';
import { DoeApprovals } from '../approvals.js';
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
it('expires unattended decisions at the declared deadline without a leaked hold', async () => {
  vi.useFakeTimers();
  try {
    const channel = new DoeApprovals();
    const controller = new AbortController();
    const pending = channel.callback(
      'default',
      () => {},
      controller.signal,
      true
    )(write, {}, context(controller.signal));
    await vi.advanceTimersByTimeAsync(600001);
    expect(await pending).toBe('deny');
    expect(channel.approve('call', true)).toBe(false);
  } finally {
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
