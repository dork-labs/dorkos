import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BoundaryError } from '../../../lib/boundary.js';
import {
  TerminalManager,
  TerminalLimitError,
  type PtyLike,
  type SpawnPtyOptions,
} from '../terminal-manager.js';

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

  it('replays output buffered while detached to a re-attaching sink (refresh recovery)', async () => {
    // Purpose (DOR-225): a page refresh detaches the old socket; output the shell
    // produces during the gap must be buffered and replayed to the new socket.
    const id = await manager.create({ cwd: boundary });
    const first = makeSink();
    manager.attach(id, first);

    // Simulate the refresh: the old socket closes and detaches.
    manager.detach(id, first);
    // The PTY keeps running and emits while no socket is attached — buffered.
    lastPty.emit('build complete\r\n');

    const second = makeSink();
    manager.attach(id, second);
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(Buffer.from(second.send.mock.calls[0][0]).toString('utf8')).toBe('build complete\r\n');
  });

  it('closes the sink when attaching to an unknown id (clean failure)', () => {
    // Purpose: a re-attach to an expired/killed PTY must fail cleanly so the
    // client falls back to a fresh create; the manager closes the doomed sink.
    const sink = makeSink();
    manager.attach('does-not-exist', sink);
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it('replaces the current sink on a second attach and routes output to the newcomer', async () => {
    // Multi-attach semantics (DOR-225): last-writer-wins. A second attach closes
    // the incumbent sink and takes over — a stale-but-still-open socket can never
    // wedge the new one.
    const id = await manager.create({ cwd: boundary });
    const stale = makeSink();
    manager.attach(id, stale);

    const fresh = makeSink();
    manager.attach(id, fresh);
    expect(stale.close).toHaveBeenCalledTimes(1);

    lastPty.emit('$ ');
    expect(stale.send).not.toHaveBeenCalled();
    expect(Buffer.from(fresh.send.mock.calls[0][0]).toString('utf8')).toBe('$ ');
  });

  it('ignores a late detach of a superseded sink (does not detach the live one)', async () => {
    // The refresh race: the old (dead) socket's close can fire AFTER the new
    // socket has already attached. detach is identity-guarded, so the late close
    // must not detach the live sink or arm idle teardown against it.
    const id = await manager.create({ cwd: boundary });
    const stale = makeSink();
    manager.attach(id, stale);
    const fresh = makeSink();
    manager.attach(id, fresh); // supersedes `stale`

    manager.detach(id, stale); // late close of the superseded socket — a no-op

    lastPty.emit('still here\r\n');
    expect(Buffer.from(fresh.send.mock.calls[0][0]).toString('utf8')).toBe('still here\r\n');
    expect(manager.has(id)).toBe(true);
  });

  it('rejects new terminals past the concurrency cap (DoS guard)', async () => {
    // Purpose: unbounded PTY creation is a local resource-exhaustion vector;
    // the cap must reject with TerminalLimitError (route → 429) once reached.
    const capped = new TerminalManager({ spawn, boundary, idleTimeoutMs: 60_000, maxTerminals: 2 });
    const first = await capped.create({ cwd: boundary });
    await capped.create({ cwd: boundary });
    await expect(capped.create({ cwd: boundary })).rejects.toBeInstanceOf(TerminalLimitError);
    // A slot frees up on teardown, so create succeeds again.
    capped.destroy(first);
    await expect(capped.create({ cwd: boundary })).resolves.toBeTypeOf('string');
  });

  describe('idle grace TTL (workbench.terminalGraceTtlMinutes)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reclaims a never-attached PTY after the injected idle timeout elapses', async () => {
      // The configured grace window (idleTimeoutMs) governs teardown: a PTY with
      // no socket is reclaimed once it lapses.
      const graced = new TerminalManager({ spawn, boundary, idleTimeoutMs: 5_000 });
      const id = await graced.create({ cwd: boundary });
      expect(graced.has(id)).toBe(true);

      vi.advanceTimersByTime(4_999);
      expect(graced.has(id)).toBe(true); // still inside the grace window
      vi.advanceTimersByTime(1);
      expect(graced.has(id)).toBe(false); // reclaimed exactly at the TTL
    });

    it('keeps a PTY alive past the TTL while a socket is attached, then reclaims after detach', async () => {
      const graced = new TerminalManager({ spawn, boundary, idleTimeoutMs: 5_000 });
      const id = await graced.create({ cwd: boundary });
      const sink = makeSink();
      graced.attach(id, sink); // attaching clears the idle timer

      vi.advanceTimersByTime(60_000);
      expect(graced.has(id)).toBe(true); // an attached terminal never idles out

      graced.detach(id, sink); // re-arms the grace window
      vi.advanceTimersByTime(5_000);
      expect(graced.has(id)).toBe(false);
    });
  });
});
