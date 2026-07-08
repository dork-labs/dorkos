import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BoundaryError } from '../../../lib/boundary.js';
import { TerminalManager, type PtyLike, type SpawnPtyOptions } from '../terminal-manager.js';

/**
 * Terminal PTY lifecycle tests. A MOCK PtyLike is injected via the manager's
 * `spawn` seam so these never depend on a real shell or the node-pty native
 * addon — they assert the manager's own behavior (spawn-in-cwd, resize
 * forwarding, teardown, boundary confinement, pre-attach buffering).
 */

/** A controllable mock PTY exposing the emit/exit hooks the manager subscribes to. */
function makeMockPty() {
  const dataListeners: ((d: string) => void)[] = [];
  const exitListeners: ((e: { exitCode: number }) => void)[] = [];
  return {
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(cb: (d: string) => void) {
      dataListeners.push(cb);
    },
    onExit(cb: (e: { exitCode: number }) => void) {
      exitListeners.push(cb);
    },
    emit(data: string) {
      dataListeners.forEach((l) => l(data));
    },
    fireExit() {
      exitListeners.forEach((l) => l({ exitCode: 0 }));
    },
  };
}

/** A sink that records everything sent to it, for asserting output delivery. */
function makeSink() {
  return { send: vi.fn(), close: vi.fn(), received: [] as Uint8Array[] };
}

describe('TerminalManager', () => {
  let boundary: string;
  let lastPty: ReturnType<typeof makeMockPty>;
  let lastSpawnOpts: SpawnPtyOptions;
  let spawn: ReturnType<typeof vi.fn>;
  let manager: TerminalManager;

  beforeEach(() => {
    // Real-path the temp root so it matches validateBoundary's realpath resolution
    // (macOS /var → /private/var), otherwise the confinement check false-rejects.
    boundary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-test-')));
    spawn = vi.fn((opts: SpawnPtyOptions): PtyLike => {
      lastSpawnOpts = opts;
      lastPty = makeMockPty();
      return lastPty;
    });
    manager = new TerminalManager({ spawn, boundary, idleTimeoutMs: 60_000 });
  });

  it('spawns a PTY in the boundary-validated cwd and tracks it by id', async () => {
    const id = await manager.create({ cwd: boundary, size: { cols: 100, rows: 40 } });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(lastSpawnOpts.cwd).toBe(boundary);
    expect(lastSpawnOpts.cols).toBe(100);
    expect(lastSpawnOpts.rows).toBe(40);
    expect(manager.has(id)).toBe(true);
  });

  it('rejects a cwd that escapes the boundary before spawning anything', async () => {
    // Purpose: a terminal is a shell in the worktree — path escape must be
    // refused with a BoundaryError and no PTY spawned.
    await expect(manager.create({ cwd: '/etc' })).rejects.toBeInstanceOf(BoundaryError);
    await expect(
      manager.create({ cwd: path.join(boundary, '..', '..', 'etc') })
    ).rejects.toBeInstanceOf(BoundaryError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('forwards resize control to the PTY', async () => {
    const id = await manager.create({ cwd: boundary });
    manager.resize(id, { cols: 132, rows: 50 });
    expect(lastPty.resize).toHaveBeenCalledWith(132, 50);
  });

  it('forwards input to the PTY stdin', async () => {
    const id = await manager.create({ cwd: boundary });
    manager.write(id, 'ls -la\r');
    expect(lastPty.write).toHaveBeenCalledWith('ls -la\r');
  });

  it('kills the PTY and forgets the id on teardown', async () => {
    const id = await manager.create({ cwd: boundary });
    manager.destroy(id);
    expect(lastPty.kill).toHaveBeenCalledTimes(1);
    expect(manager.has(id)).toBe(false);
  });

  it('tears the terminal down when the PTY exits on its own', async () => {
    const id = await manager.create({ cwd: boundary });
    lastPty.fireExit();
    expect(manager.has(id)).toBe(false);
  });

  it('buffers pre-attach output and flushes it to the sink on attach', async () => {
    const id = await manager.create({ cwd: boundary });
    // Output arrives before any socket attaches — it must be buffered, not lost.
    lastPty.emit('welcome\r\n');
    const sink = makeSink();
    manager.attach(id, sink);
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(Buffer.from(sink.send.mock.calls[0][0]).toString('utf8')).toBe('welcome\r\n');
  });

  it('streams live output straight to an attached sink', async () => {
    const id = await manager.create({ cwd: boundary });
    const sink = makeSink();
    manager.attach(id, sink);
    lastPty.emit('$ ');
    expect(Buffer.from(sink.send.mock.calls[0][0]).toString('utf8')).toBe('$ ');
  });
});
