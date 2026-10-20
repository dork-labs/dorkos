import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerTransport } from '@dorkos/shared/transport-computers';
import { ComputerViewerSession, computerViewerSession } from '../model/computer-viewer-session';

function fixture() {
  const frame = { generation: 4, dataUrl: 'data:image/png;base64,YQ==', width: 800, height: 600 };
  const transport = {
    getComputerFrame: vi.fn().mockResolvedValue(frame),
    acquireComputerControl: vi.fn().mockResolvedValue({ generation: 4, leaseId: 'lease-4' }),
    releaseComputerControl: vi.fn().mockResolvedValue(undefined),
    sendComputerInput: vi.fn().mockResolvedValue(undefined),
  };
  const session = new ComputerViewerSession(transport as unknown as ComputerTransport, 4);
  return { frame, transport, session };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('shared computer viewer session', () => {
  it('ignores an old release failure after a new explicit takeover', async () => {
    const { session, transport, frame } = fixture();
    let reject!: (reason: Error) => void;
    transport.releaseComputerControl.mockReturnValueOnce(
      new Promise<void>((_, failed) => {
        reject = failed;
      })
    );
    const close = session.subscribe('panel', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await session.acquire('panel');
    const release = session.release();
    transport.acquireComputerControl.mockResolvedValueOnce({ generation: 4, leaseId: 'new' });
    await session.acquire('panel');
    reject(new Error('old release failed'));
    await release;
    expect(session.getSnapshot()).toMatchObject({
      frame,
      lease: { leaseId: 'new' },
      owner: 'panel',
      error: false,
    });
    close();
  });
  it('does not revoke a new takeover when an old input fails late', async () => {
    const { session, transport, frame } = fixture();
    let reject!: (reason: Error) => void;
    transport.sendComputerInput.mockReturnValueOnce(
      new Promise<void>((_, failed) => {
        reject = failed;
      })
    );
    const close = session.subscribe('panel', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await session.acquire('panel');
    const input = session.send('panel', { kind: 'key', key: 'a', action: 'down' });
    await vi.advanceTimersByTimeAsync(0);
    await session.release();
    transport.acquireComputerControl.mockResolvedValueOnce({ generation: 4, leaseId: 'new' });
    await session.acquire('panel');
    reject(new Error('old lease expired'));
    expect(await input).toBe(false);
    expect(session.getSnapshot()).toMatchObject({
      frame,
      lease: { leaseId: 'new' },
      owner: 'panel',
      error: false,
    });
    expect(transport.releaseComputerControl).toHaveBeenCalledTimes(1);
    close();
  });
  it('keeps a healthy desktop visible when takeover is refused', async () => {
    const { session, transport, frame } = fixture();
    const close = session.subscribe('panel', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    transport.acquireComputerControl.mockRejectedValueOnce(new Error('already controlled'));
    await session.acquire('panel');
    expect(session.getSnapshot()).toMatchObject({
      frame,
      lease: null,
      error: false,
      controlError: true,
      busy: false,
    });
    await session.acquire('panel');
    expect(session.getSnapshot()).toMatchObject({ owner: 'panel', controlError: false });
    close();
  });
  // A watcher leaving must not cancel a different presenter's explicit in-flight takeover.
  it('keeps pending control when only an observing presenter disappears', async () => {
    const { session, transport } = fixture();
    let finish!: (lease: { leaseId: string; generation: number }) => void;
    transport.acquireComputerControl.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const observer = session.subscribe('observer', vi.fn());
    const controller = session.subscribe('controller', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const acquired = session.acquire('controller');
    observer();
    finish({ leaseId: 'owned', generation: 4 });
    await acquired;
    expect(session.getSnapshot()).toMatchObject({
      owner: 'controller',
      lease: { leaseId: 'owned' },
    });
    expect(transport.releaseComputerControl).not.toHaveBeenCalled();
    controller();
  });
  // Two mounted presenters must share capture and cannot use each other's input ownership.
  it('shares a single frame loop and accepts input only from the explicit owner', async () => {
    const { session, transport } = fixture();
    const closePanel = session.subscribe('panel', vi.fn());
    const closePip = session.subscribe('pip', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.getComputerFrame).toHaveBeenCalledTimes(1);
    await session.acquire('panel');
    await session.acquire('pip');
    expect(transport.acquireComputerControl).toHaveBeenCalledTimes(1);
    expect(await session.send('pip', { kind: 'key', key: 'x', action: 'down' })).toBe(false);
    expect(await session.send('panel', { kind: 'key', key: 'x', action: 'down' })).toBe(true);
    expect(transport.sendComputerInput).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.getComputerFrame).toHaveBeenCalledTimes(2);
    closePanel();
    expect(session.getSnapshot().lease).toBeNull();
    expect(transport.releaseComputerControl).toHaveBeenCalledWith('lease-4');
    closePip();
    await vi.advanceTimersByTimeAsync(1500);
    expect(transport.getComputerFrame).toHaveBeenCalledTimes(2);
  });

  // A pop-out while takeover is pending must return the late lease rather than granting hidden control.
  it('returns a late takeover after the acquiring presenter closes', async () => {
    const { session, transport } = fixture();
    let finish!: (lease: { leaseId: string; generation: number }) => void;
    transport.acquireComputerControl.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const close = session.subscribe('panel', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const acquired = session.acquire('panel');
    close();
    finish({ leaseId: 'late', generation: 4 });
    await acquired;
    expect(session.getSnapshot().lease).toBeNull();
    expect(transport.releaseComputerControl).toHaveBeenCalledWith('late');
  });

  // Local revocation is synchronous even while an input call is in flight.
  it('drops queued input on transfer before the server acknowledges release', async () => {
    const { session, transport } = fixture();
    let finish!: () => void;
    transport.sendComputerInput.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    const close = session.subscribe('panel', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await session.acquire('panel');
    const first = session.send('panel', { kind: 'key', key: 'a', action: 'down' });
    const second = session.send('panel', { kind: 'key', key: 'b', action: 'down' });
    await vi.advanceTimersByTimeAsync(0);
    await session.release();
    finish();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(transport.sendComputerInput).toHaveBeenCalledTimes(1);
    close();
  });

  // A failed frame must remove the old image and lease; recovery must not acquire control.
  it('clears stale frames on disconnect and reconnects in observe mode', async () => {
    const { session, transport, frame } = fixture();
    const close = session.subscribe('panel', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await session.acquire('panel');
    transport.getComputerFrame.mockRejectedValueOnce(new Error('gone'));
    await vi.advanceTimersByTimeAsync(500);
    expect(session.getSnapshot()).toMatchObject({ frame: null, lease: null, error: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(session.getSnapshot()).toMatchObject({ frame, lease: null, error: false });
    expect(transport.acquireComputerControl).toHaveBeenCalledTimes(1);
    close();
  });

  // Restart replaces the session, stopping the previous generation even if an exit animation still holds it.
  it('retires the old generation before the replacement starts', async () => {
    const { transport } = fixture();
    const old = computerViewerSession(transport as unknown as ComputerTransport, 4);
    const closeOld = old.subscribe('old', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await old.acquire('old');
    const next = computerViewerSession(transport as unknown as ComputerTransport, 5);
    transport.getComputerFrame.mockResolvedValue({
      generation: 5,
      dataUrl: 'data:image/png;base64,YQ==',
      width: 800,
      height: 600,
    });
    const closeNew = next.subscribe('new', vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(old.getSnapshot()).toMatchObject({ frame: null, lease: null, error: true });
    expect(transport.getComputerFrame).toHaveBeenCalledTimes(4);
    expect(await old.send('old', { kind: 'key', key: 'x', action: 'down' })).toBe(false);
    expect(next.getSnapshot().frame?.generation).toBe(5);
    closeOld();
    closeNew();
  });
});
