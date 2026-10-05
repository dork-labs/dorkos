/**
 * The virtual socket's flow control and its cap (DOR-2686 task 5.1 review),
 * driven in memory: an end whose reader is full asks the other side to
 * pause, a side told to pause holds its write callbacks until it hears
 * resume, and an end whose peer ignores the pause is cut off at the cap,
 * with the bytes that arrived while paused never counting as activity.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConnMessage } from '../ipc-protocol.js';
import { VirtualSocket } from '../virtual-socket.js';

const FRAME = new Uint8Array(64 * 1024);

describe('VirtualSocket flow control', () => {
  // Purpose: a peer that keeps sending while nobody reads is paused once,
  // then cut off at the cap; paused bytes don't reset the idle timer.
  it('pauses, then cuts off a peer that ignores the pause', () => {
    const sent: ConnMessage[] = [];
    const onActivity = vi.fn();
    const socket = new VirtualSocket({
      cid: 1,
      send: (m) => {
        sent.push(m);
        return true;
      },
      onActivity,
      maxBufferedBytes: 1024 * 1024,
    });
    const errors: Error[] = [];
    socket.on('error', (err) => errors.push(err));
    for (let i = 0; i < 40 && !socket.destroyed; i++) {
      socket.receive({ type: 'conn-data', cid: 1, chunk: FRAME });
    }
    expect(sent.filter((m) => m.type === 'conn-pause')).toHaveLength(1);
    expect(socket.destroyed).toBe(true);
    expect(socket.readableLength).toBeLessThanOrEqual(1024 * 1024 + FRAME.byteLength);
    // Only the first frame, before the pause, counted as activity.
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  // Purpose: reading again sends resume.
  it('resumes the peer once read', () => {
    const sent: ConnMessage[] = [];
    const socket = new VirtualSocket({
      cid: 2,
      send: (m) => {
        sent.push(m);
        return true;
      },
    });
    socket.receive({ type: 'conn-data', cid: 2, chunk: FRAME });
    expect(sent.at(-1)?.type).toBe('conn-pause');
    socket.read();
    expect(sent.at(-1)?.type).toBe('conn-resume');
  });

  // Purpose: told to pause, a writer's callbacks wait for resume, which is
  // what makes res.write() report backpressure in the child.
  it('holds write callbacks while the peer is paused', async () => {
    const socket = new VirtualSocket({
      cid: 3,
      send: (_m, onWritten) => {
        onWritten?.();
        return true;
      },
    });
    socket.receive({ type: 'conn-pause', cid: 3 });
    const done = vi.fn();
    socket.write(Buffer.alloc(10), done);
    await new Promise((r) => setTimeout(r, 20));
    expect(done).not.toHaveBeenCalled();
    socket.receive({ type: 'conn-resume', cid: 3 });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toHaveBeenCalledTimes(1);
  });

  // Purpose: a write completes only once the channel wrote its last frame,
  // so a fast writer is held to the channel's pace rather than queued.
  it('completes a write only when the channel has written it', async () => {
    let written: (() => void) | undefined;
    const socket = new VirtualSocket({
      cid: 4,
      send: (_m, onWritten) => {
        if (onWritten) written = onWritten;
        return true;
      },
    });
    const done = vi.fn();
    socket.write(Buffer.alloc(200 * 1024), done);
    await new Promise((r) => setTimeout(r, 20));
    expect(done).not.toHaveBeenCalled();
    written!();
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toHaveBeenCalledTimes(1);
  });
});
