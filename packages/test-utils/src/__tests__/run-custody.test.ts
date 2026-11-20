import { describe, expect, it, vi } from 'vitest';
import {
  createRunAuthority,
  createRunSpawnPort,
  createByteLane,
  custodyAsset,
  custodyReceipt,
  MAX_FRAME_BYTES,
  MAX_LANE_CREDIT,
  RunStartError,
  type RunChild,
  type BackendEndpoint,
  type RunRequest,
} from '../run-custody/index.mjs';

const request: RunRequest = {
  executable: '/fixture/opencode',
  cwd: '/fixture',
  argv: ['serve', 'argv-secret'],
  env: { TOKEN: 'env-secret' },
  stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
};

function fixture(
  launch: (
    input: RunRequest,
    endpoint: BackendEndpoint
  ) => ReturnType<Parameters<typeof createRunSpawnPort>[0]['launch']>
) {
  const authority = createRunAuthority();
  const mainOwner = new AbortController();
  const scopeOwner = new AbortController();
  const caller = new AbortController();
  const main = authority.openMain(mainOwner.signal);
  const scope = authority.openScope(main, scopeOwner.signal);
  const port = createRunSpawnPort({ authority, main, scope, launch, cleanupMs: 100 });
  return { mainOwner, scopeOwner, caller, port };
}

async function rejectedStart(pending: Promise<RunChild>): Promise<RunStartError> {
  try {
    await pending;
  } catch (error) {
    if (!(error instanceof RunStartError)) throw error;
    return error;
  }
  throw new Error('Expected a typed custody rejection');
}

describe('private run custody protocol', () => {
  it('loads the private entry before any process or listener backend is needed', async () => {
    vi.resetModules();
    const rejectImport = () => {
      throw new Error('Inert custody import reached a process or listener backend');
    };
    vi.doMock('node:child_process', rejectImport);
    vi.doMock('node:net', rejectImport);
    vi.doMock('node:http', rejectImport);
    try {
      const module = await import('../run-custody/index.mjs');
      expect(module.createRunSpawnPort).toBeTypeOf('function');
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:net');
      vi.doUnmock('node:http');
    }
  });

  it('resolves module-relative assets and accepts only current independent lifelines', () => {
    expect(custodyAsset('index.mjs').href).toBe(
      new URL('../run-custody/index.mjs', import.meta.url).href
    );
    expect(() => custodyAsset('../escape')).toThrow();
    const authority = createRunAuthority();
    const mainOwner = new AbortController();
    const scopeOwner = new AbortController();
    const main = authority.openMain(mainOwner.signal);
    expect(() => authority.openScope(main, mainOwner.signal)).toThrow(/independently/);
    const scope = authority.openScope(main, scopeOwner.signal);
    expect(authority.signals(main, scope)).toEqual([mainOwner.signal, scopeOwner.signal]);
    expect(() => createRunAuthority().signals(main, scope)).toThrow(/expired/);
    mainOwner.abort();
    const next = authority.openMain(new AbortController().signal);
    expect(() => authority.signals(next, scope)).toThrow(/expired/);
  });

  it('enforces exact frame and outstanding credit bounds, preserving order and EOF', async () => {
    const lane = createByteLane();
    const frame = (byte: number) => new Uint8Array(MAX_FRAME_BYTES).fill(byte);
    await expect(lane.writer.write(new Uint8Array(MAX_FRAME_BYTES + 1))).rejects.toThrow(
      RangeError
    );
    for (let i = 1; i <= 4; i++) await lane.writer.write(frame(i));
    expect(lane.creditUsed).toBe(MAX_LANE_CREDIT);
    const blocked = vi.fn();
    const submitted = frame(5);
    const pending = lane.writer.write(submitted).then(blocked);
    submitted.fill(99);
    expect(lane.writer.end()).toBe(true);
    expect(lane.writer.end()).toBe(false);
    await expect(lane.writer.write(frame(6))).rejects.toThrow(/closed/);
    expect(blocked).not.toHaveBeenCalled();
    expect(lane.creditUsed).toBe(MAX_LANE_CREDIT);
    expect(await lane.reader.read()).toEqual({ kind: 'bytes', frame: frame(1) });
    await pending;
    expect(lane.creditUsed).toBe(MAX_LANE_CREDIT);
    for (let i = 2; i <= 5; i++)
      expect(await lane.reader.read()).toEqual({ kind: 'bytes', frame: frame(i) });
    expect(await lane.reader.read()).toEqual({ kind: 'eof' });
  });

  it.each(['fail', 'abandon'] as const)('unblocks a deferred EOF producer on %s', async (stop) => {
    const lane = createByteLane();
    const frame = new Uint8Array(MAX_FRAME_BYTES);
    for (let i = 0; i < 4; i++) await lane.writer.write(frame);
    const pending = expect(lane.writer.write(new Uint8Array([42]))).rejects.toThrow(/closed/);
    expect(lane.writer.end()).toBe(true);
    const error = new Error('Fixture lane stopped');
    if (stop === 'fail') {
      expect(lane.writer.fail(error)).toBe(true);
      for (let i = 0; i < 4; i++)
        expect(await lane.reader.read()).toEqual({ kind: 'bytes', frame });
    } else {
      lane.abandon(error);
    }
    await pending;
    expect(lane.creditUsed).toBe(0);
    expect(await lane.reader.read()).toEqual({ kind: 'error', error });
  });

  it.each(['mainOwner', 'scopeOwner'] as const)(
    'cancels independently on %s loss and refuses late publication',
    async (owner) => {
      let endpoint!: BackendEndpoint;
      const stop = vi.fn(() => ({ kind: 'cleaned-owned' as const }));
      const f = fixture((_request, received) => {
        endpoint = received;
        endpoint.own(stop);
        return new Promise<void>(() => {});
      });
      const pending = rejectedStart(f.port.start(request, f.caller.signal));
      await Promise.resolve();
      expect(endpoint.signal.aborted).toBe(false);
      await expect(f.port.start(request, f.caller.signal)).rejects.toThrow(/outstanding/);
      f[owner].abort();
      expect(endpoint.signal.aborted).toBe(true);
      expect(endpoint.spawned({ pid: 7, executable: request.executable })).toBe(false);
      expect((await pending).outcome).toMatchObject({
        kind: 'interrupted',
        reason: 'owner-lost',
        cleanup: { kind: 'cleaned-owned' },
      });
      expect(stop).toHaveBeenCalledTimes(1);
    }
  );

  it('retains fast output and separates exit, stream EOF, native close and idempotent join', async () => {
    const stop = vi.fn(() => ({ kind: 'cleaned-owned' as const }));
    let endpoint!: BackendEndpoint;
    const f = fixture(async (_request, received) => {
      endpoint = received;
      endpoint.own(stop);
      expect(endpoint.spawned({ pid: 8, executable: request.executable, birth: 'fixture' })).toBe(
        true
      );
      expect(endpoint.spawned({ pid: 9, executable: request.executable })).toBe(false);
      await endpoint.stdout!.write(new Uint8Array([42]));
      expect(endpoint.exited({ code: 0, signal: null })).toBe(true);
      expect(endpoint.exited({ code: 1, signal: null })).toBe(false);
    });
    const child = await f.port.start(request, f.caller.signal);
    await expect(child.spawn).resolves.toMatchObject({ kind: 'spawned', pid: 8 });
    await expect(child.exit).resolves.toEqual({ kind: 'exited', code: 0, signal: null });
    const closed = vi.fn();
    void child.close.then(closed);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    expect(await child.stdout!.read()).toEqual({ kind: 'bytes', frame: new Uint8Array([42]) });
    endpoint.stdout!.end();
    expect(await child.stdout!.read()).toEqual({ kind: 'eof' });
    expect(endpoint.closed({ integrity: 'verified' })).toBe(true);
    expect(endpoint.closed({ integrity: 'unobserved' })).toBe(false);
    await expect(child.close).resolves.toEqual({ kind: 'native-closed', integrity: 'verified' });
    const join = child.stopAndJoin('complete', Date.now() + 100);
    expect(child.stopAndJoin('repeat', Date.now() + 100)).toBe(join);
    await expect(join).resolves.toEqual({ kind: 'cleaned-owned' });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('explicitly closes with unread output while preserving native exit and close facts', async () => {
    const stop = vi.fn(() => ({ kind: 'cleaned-owned' as const }));
    const f = fixture(async (_request, endpoint) => {
      endpoint.own(stop);
      endpoint.spawned({ pid: 19, executable: request.executable });
      await endpoint.stdout!.write(new Uint8Array([42]));
      expect(endpoint.stdout!.end()).toBe(true);
      expect(endpoint.exited({ code: 0, signal: null })).toBe(true);
      expect(endpoint.closed({ integrity: 'verified' })).toBe(true);
    });
    const child = await f.port.start(request, f.caller.signal);
    const deadline = Date.now() + 100;
    await expect(child.stopAndJoin('caller-close', deadline)).resolves.toEqual({
      kind: 'cleaned-owned',
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith('caller-close', deadline);
    await expect(child.stdout!.read()).resolves.toMatchObject({ kind: 'error' });
    await expect(child.exit).resolves.toEqual({ kind: 'exited', code: 0, signal: null });
    await expect(child.close).resolves.toEqual({ kind: 'native-closed', integrity: 'verified' });
  });

  it('reports unsupported startup without an acquired owner or child', async () => {
    const launch = vi.fn(() => ({ kind: 'unsupported' as const }));
    const f = fixture(launch);
    const { outcome } = await rejectedStart(f.port.start(request, f.caller.signal));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: 'unsupported',
      cleanup: { kind: 'never-acquired', reason: 'acquisition-failed' },
    });
    if (outcome.kind !== 'unsupported') throw new Error('Expected unsupported startup');
    expect(custodyReceipt(outcome)).toEqual({ kind: 'unsupported' });
    if (outcome.cleanup.kind !== 'never-acquired') throw new Error('Expected no acquired owner');
    expect(custodyReceipt(outcome.cleanup)).toEqual({ kind: 'never-acquired' });
  });

  it('keeps transport loss and unread streams honest while bounding a nonresponsive cleanup', async () => {
    let endpoint!: BackendEndpoint;
    const f = fixture(async (_request, received) => {
      endpoint = received;
      endpoint.own(() => new Promise<never>(() => {}));
      endpoint.spawned({ pid: 9, executable: request.executable });
      await endpoint.stderr!.write(new Uint8Array([42]));
    });
    const child = await f.port.start(request, f.caller.signal);
    expect(endpoint.lost()).toBe(true);
    expect(endpoint.lost()).toBe(false);
    await expect(child.close).resolves.toEqual({ kind: 'transport-lost' });
    await expect(child.stopAndJoin('repeat', Date.now() + 100)).resolves.toMatchObject({
      kind: 'cleanup-uncertain',
      reason: 'deadline',
    });
    await expect(child.exit).resolves.toEqual({ kind: 'unobserved' });
    await expect(child.stderr!.read()).resolves.toMatchObject({ kind: 'error' });
    await expect(f.port.start(request, f.caller.signal)).rejects.toThrow(/unconfirmed cleanup/);
  });

  it('rechecks the deadline before calling the backend in its startup microtask', async () => {
    vi.useFakeTimers();
    try {
      const launch = vi.fn();
      const f = fixture(launch);
      const now = Date.now();
      const pending = rejectedStart(
        f.port.start({ ...request, deadline: now + 1 }, f.caller.signal)
      );
      vi.setSystemTime(now + 1);
      expect((await pending).outcome).toMatchObject({ kind: 'never-acquired', reason: 'deadline' });
      expect(launch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires an outstanding startup without extending the supplied deadline', async () => {
    vi.useFakeTimers();
    try {
      let endpoint!: BackendEndpoint;
      const stop = vi.fn(() => ({ kind: 'cleaned-owned' as const }));
      const f = fixture((_request, received) => {
        endpoint = received;
        endpoint.own(stop);
        return new Promise<void>(() => {});
      });
      const pending = rejectedStart(
        f.port.start({ ...request, deadline: Date.now() + 20 }, f.caller.signal)
      );
      await vi.advanceTimersByTimeAsync(20);
      expect((await pending).outcome).toMatchObject({
        kind: 'interrupted',
        reason: 'deadline',
        cleanup: { kind: 'cleaned-owned' },
      });
      expect(endpoint.signal.aborted).toBe(true);
      expect(endpoint.spawned({ pid: 17, executable: request.executable })).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not launch after deadline and keeps undefined primary failure separate from cleanup failure', async () => {
    const cleanupError = new Error('cleanup-secret');
    const launch = vi.fn((_request: RunRequest, endpoint: BackendEndpoint) => {
      endpoint.own(() => {
        throw cleanupError;
      });
      throw undefined;
    });
    const f = fixture(launch);
    const expired = await rejectedStart(
      f.port.start({ ...request, deadline: Date.now() - 1 }, f.caller.signal)
    );
    expect(expired.outcome).toMatchObject({ kind: 'never-acquired', reason: 'deadline' });
    expect(launch).not.toHaveBeenCalled();
    const failure = await rejectedStart(f.port.start(request, f.caller.signal));
    expect(JSON.stringify(failure)).not.toContain('cleanup-secret');
    const result = failure.outcome;
    expect(result).toEqual({
      kind: 'spawn-failed',
      error: undefined,
      cleanup: { kind: 'cleanup-uncertain', reason: 'backend-error', error: cleanupError },
    });
    if (result.kind !== 'spawn-failed') throw new Error('Expected pre-PID failure');
    expect(JSON.stringify(custodyReceipt(result))).toBe('{"kind":"spawn-failed"}');
    expect(JSON.stringify(custodyReceipt(result.cleanup))).toBe('{"kind":"cleanup-uncertain"}');
  });
});
