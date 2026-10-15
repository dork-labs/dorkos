import { EventEmitter } from 'node:events';
import type { CDPSession, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { ExistingPageFocus, ExistingPageFocusSelection } from '../page-focus.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const events = new EventEmitter();
  const frame = {};
  const session = {
    send: vi.fn(
      async (_command: string, _params: { enabled: boolean }): Promise<void> => undefined
    ),
    detach: vi.fn(async (): Promise<void> => undefined),
  };
  const context = { newCDPSession: vi.fn(async () => session as unknown as CDPSession) };
  const page = {
    context: () => context,
    mainFrame: () => frame,
    on: events.on.bind(events),
    off: events.off.bind(events),
  } as unknown as Page;
  return { events, frame, session, context, page };
}
const command = 'Emulation.setFocusEmulationEnabled';

describe('selected existing page focus lifetime', () => {
  it('bounds actor readiness, fences a late reset, and requires a new selection', async () => {
    vi.useFakeTimers();
    try {
      const { page, session, context, events, frame } = fixture();
      const selection = new ExistingPageFocusSelection();
      await selection.select(page);
      const gate = deferred<void>();
      session.send.mockImplementationOnce(() => gate.promise);
      events.emit('framenavigated', frame);
      const waiting = selection.ready();
      const refused = expect(waiting).rejects.toMatchObject({ code: 'focus_unavailable' });
      await vi.advanceTimersByTimeAsync(750);
      await refused;
      await expect(selection.ready()).rejects.toMatchObject({ code: 'focus_unavailable' });
      const selecting = selection.select(page);
      expect(context.newCDPSession).toHaveBeenCalledOnce();
      gate.resolve();
      await selecting;
      expect(session.send.mock.calls.filter((call) => call[1]?.enabled === true)).toHaveLength(2);
      expect(session.detach).toHaveBeenCalledOnce();
      await selection.ready();
      await selection.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes the old restoration before reattaching the same selected page', async () => {
    const { page, session, context } = fixture();
    const selection = new ExistingPageFocusSelection();
    await selection.select(page);
    const gate = deferred<void>();
    session.send.mockImplementationOnce(() => gate.promise);
    const selecting = selection.select(page);
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(3));
    expect(context.newCDPSession).toHaveBeenCalledOnce();
    gate.resolve();
    await selecting;
    expect(session.detach).toHaveBeenCalledOnce();
    expect(context.newCDPSession).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenLastCalledWith(command, { enabled: true });
    await selection.release();
  });

  it('bounds teardown even when a selected CDP session never confirms detach', async () => {
    const { page, session } = fixture();
    const selection = new ExistingPageFocusSelection();
    await selection.select(page);
    const detach = deferred<void>();
    session.detach.mockImplementationOnce(() => detach.promise);
    vi.useFakeTimers();
    try {
      let released = false;
      const releasing = selection.release().then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(749);
      expect(released).toBe(false);
      expect(session.send).toHaveBeenLastCalledWith(command, { enabled: false });
      expect(session.detach).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await releasing;
      expect(released).toBe(true);
    } finally {
      detach.resolve();
      vi.useRealTimers();
    }
  });

  it('bounds initial selection and detaches a late session without enabling it', async () => {
    vi.useFakeTimers();
    try {
      const { page, session, context } = fixture();
      const gate = deferred<CDPSession>();
      context.newCDPSession.mockImplementationOnce(() => gate.promise);
      const selection = new ExistingPageFocusSelection();
      const selecting = selection.select(page);
      const refused = expect(selecting).rejects.toMatchObject({ code: 'focus_unavailable' });
      await vi.advanceTimersByTimeAsync(5_000);
      await refused;
      gate.resolve(session as unknown as CDPSession);
      await vi.runAllTimersAsync();
      expect(session.send).toHaveBeenCalledExactlyOnceWith(command, { enabled: false });
      expect(session.detach).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets only main-frame navigation and restores focus before detaching', async () => {
    const { page, session, events, frame } = fixture();
    const focus = new ExistingPageFocus(page);
    await focus.ready();
    events.emit('framenavigated', {});
    await focus.ready();
    expect(session.send.mock.calls).toEqual([
      [command, { enabled: false }],
      [command, { enabled: true }],
    ]);
    events.emit('framenavigated', frame);
    await focus.ready();
    expect(session.send).toHaveBeenCalledTimes(4);
    await focus.release();
    expect(session.send).toHaveBeenLastCalledWith(command, { enabled: false });
    expect(session.detach).toHaveBeenCalledOnce();
    expect(events.listenerCount('framenavigated')).toBe(0);
    expect(events.listenerCount('close')).toBe(0);
    events.emit('framenavigated', frame);
    await focus.release();
    expect(session.send).toHaveBeenCalledTimes(5);
  });

  it('waits for serialized resets before allowing page work', async () => {
    const { page, session, events, frame } = fixture();
    const focus = new ExistingPageFocus(page);
    await focus.ready();
    const gate = deferred<void>();
    session.send.mockImplementationOnce(() => gate.promise);
    events.emit('framenavigated', frame);
    events.emit('framenavigated', frame);
    let ready = false;
    const waiting = focus.ready().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    gate.resolve();
    await waiting;
    expect(session.send).toHaveBeenCalledTimes(6);
    await focus.release();
  });

  it('detaches a late attachment without enabling a released selection', async () => {
    const { page, session, context } = fixture();
    const gate = deferred<CDPSession>();
    context.newCDPSession.mockImplementationOnce(() => gate.promise);
    const focus = new ExistingPageFocus(page);
    const release = focus.release();
    gate.resolve(session as unknown as CDPSession);
    await release;
    expect(session.send).toHaveBeenCalledExactlyOnceWith(command, { enabled: false });
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it('does not re-enable focus when released during a reset', async () => {
    const { page, session } = fixture();
    const gate = deferred<void>();
    session.send.mockImplementationOnce(() => gate.promise);
    const focus = new ExistingPageFocus(page);
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
    const release = focus.release();
    gate.resolve();
    await release;
    expect(session.send.mock.calls).toEqual([
      [command, { enabled: false }],
      [command, { enabled: false }],
    ]);
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it('restores and detaches on page close even when focus setup failed', async () => {
    const { page, session, events } = fixture();
    session.send.mockRejectedValueOnce(new Error('renderer closed'));
    const focus = new ExistingPageFocus(page);
    await expect(focus.ready()).rejects.toThrow('renderer closed');
    events.emit('close');
    await focus.release();
    expect(session.detach).toHaveBeenCalledOnce();
    expect(events.listenerCount('framenavigated')).toBe(0);
  });
});
