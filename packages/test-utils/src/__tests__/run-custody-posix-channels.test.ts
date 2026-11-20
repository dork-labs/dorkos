import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createRunAuthority,
  createRunSpawnPort,
  MAX_FRAME_BYTES,
  RunStartError,
} from '../run-custody/index.mjs';
import { createControlWriter } from '../run-custody/posix/control.mjs';
import { bindWorkerReports } from '../run-custody/posix/worker-reports.mjs';
import { bindPosixGuardian } from '../run-custody/posix/host.mjs';
import { classifyPosixJoin } from '../run-custody/posix/join-fact.mjs';
import { authLine, verifyLine } from '../run-custody/posix/scope-auth.mjs';
import {
  forwardOutput,
  socketLaneReader,
  socketLaneWriter,
} from '../run-custody/posix/socket-lane.mjs';

function pair(): [Duplex, Duplex] {
  const endpoints: Duplex[] = [];
  for (let index = 0; index < 2; index++) {
    const peer = () => endpoints[1 - index]!;
    endpoints.push(
      new Duplex({
        allowHalfOpen: true,
        read() {},
        write(chunk: Buffer, _encoding, done) {
          peer().push(Buffer.from(chunk));
          done();
        },
        final(done) {
          peer().push(null);
          done();
        },
      })
    );
  }
  return [endpoints[0]!, endpoints[1]!];
}

describe('private POSIX scope channels', () => {
  it('separates claim and acceptance authentication and binds each role to its endpoint', () => {
    const connection = { endpointId: '12'.repeat(16), token: '34'.repeat(32) };
    const claim = authLine(connection, 'control', 'claim').trimEnd();
    expect(verifyLine(connection, claim, 'claim')).toBe('control');
    expect(verifyLine(connection, claim, 'accepted')).toBeUndefined();
    expect(verifyLine(connection, claim.replace('control', 'stdout'), 'claim')).toBeUndefined();
    expect(
      verifyLine({ ...connection, endpointId: '56'.repeat(16) }, claim, 'claim')
    ).toBeUndefined();
    expect(claim).not.toContain(connection.token);
  });

  it('normalizes only a clean authenticated no-target receipt after holding guardian ownership', async () => {
    const recovered = classifyPosixJoin({ kind: 'never-acquired' }, false);
    expect(recovered).toEqual({ kind: 'cleaned-owned', target: 'never-authorized' });
    expect(classifyPosixJoin({ kind: 'never-acquired' }, true)).toEqual({
      kind: 'cleanup-uncertain',
      reason: 'guardian-no-target-contradicted',
    });
    expect(classifyPosixJoin(undefined, false)).toMatchObject({ kind: 'cleanup-uncertain' });
    const authority = createRunAuthority();
    const main = authority.openMain(new AbortController().signal);
    const scope = authority.openScope(main, new AbortController().signal);
    const request = {
      executable: '/fixture',
      argv: [],
      cwd: '/',
      env: {},
      stdio: { stdin: 'ignore' as const, stdout: 'ignore' as const, stderr: 'ignore' as const },
    };
    const start = async (
      outcome: typeof recovered | { kind: 'never-acquired'; reason: string }
    ) => {
      const port = createRunSpawnPort({
        authority,
        main,
        scope,
        cleanupMs: 100,
        launch(_request, endpoint) {
          endpoint.own(() => outcome);
          throw new Error('fixture refused PRE');
        },
      });
      return port.start(request, new AbortController().signal).catch((error: unknown) => {
        if (!(error instanceof RunStartError)) throw error;
        return error.outcome;
      });
    };
    expect(await start(recovered)).toMatchObject({
      kind: 'spawn-failed',
      cleanup: { kind: 'cleaned-owned', target: 'never-authorized' },
    });
    expect(await start({ kind: 'never-acquired', reason: 'unqualified' })).toMatchObject({
      kind: 'spawn-failed',
      cleanup: { kind: 'cleanup-uncertain', reason: 'invalid-backend-cleanup' },
    });
  });

  it('returns an owned but unusable guardian when cancellation beats readiness', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });
    const signal = new AbortController();
    const connection = { endpointId: '12'.repeat(16), token: '34'.repeat(32) };
    const opening = bindPosixGuardian(child, connection, signal.signal);
    signal.abort();
    const owned = await opening;
    expect(child.stdin.writableEnded).toBe(true);
    expect(owned.connection).toEqual({ endpointId: '', token: '' });
    expect(await owned.join(Date.now())).toBe('cleanup-uncertain');
    child.stdout.write('never-acquired\n');
    child.emit('close', 0, null);
    expect(await owned.join(Date.now() + 100)).toBe('closed');
    child.stdin.destroy();
    child.stdout.destroy();
  });

  it('admits only one credit window, then drains a snapshotted write ahead of EOF', async () => {
    const [outgoing, incoming] = pair();
    try {
      const writer = socketLaneWriter(outgoing);
      const reader = socketLaneReader(incoming);
      const filled = (value: number) => new Uint8Array(MAX_FRAME_BYTES).fill(value);
      for (let i = 1; i <= 4; i++) await writer.write(filled(i));
      const submitted = Uint8Array.of(42);
      const admitted = vi.fn();
      const pending = writer.write(submitted).then(admitted);
      submitted[0] = 99;
      expect(writer.end()).toBe(true);
      expect(admitted).not.toHaveBeenCalled();
      expect(await reader.read()).toEqual({ kind: 'bytes', frame: filled(1) });
      await pending;
      for (let i = 2; i <= 4; i++)
        expect(await reader.read()).toEqual({ kind: 'bytes', frame: filled(i) });
      expect(await reader.read()).toEqual({ kind: 'bytes', frame: Uint8Array.of(42) });
      expect(await reader.read()).toEqual({ kind: 'eof' });
    } finally {
      outgoing.destroy();
      incoming.destroy();
    }
  });

  it('waits for asynchronous native close and leaves independent output alive after joined control EOF', async () => {
    const [guardian, worker] = pair();
    const [output, input] = pair();
    const connection = { endpointId: '23'.repeat(16), token: '45'.repeat(32) };
    const send = createControlWriter(connection.token, connection.endpointId, 'anchor-to-guardian');
    const writer = socketLaneWriter(output);
    const reader = socketLaneReader(input);
    let finishObserver!: () => void;
    const observer = new Promise<void>((resolve) => {
      finishObserver = resolve;
    });
    const receive = vi.fn(async () => {
      await observer;
    });
    const joined = vi.fn();
    const lost = vi.fn(() => input.destroy());
    try {
      bindWorkerReports(worker, connection, { receive, joined, lost, retainOutput: () => true });
      guardian.write(send('closed', { native: true }));
      guardian.end(send('joined', { kind: 'cleaned-owned' }));
      await vi.waitFor(() => expect(worker.readableEnded).toBe(true));
      expect(receive).toHaveBeenCalledWith('closed', { native: true });
      expect(joined).not.toHaveBeenCalled();
      expect(lost).not.toHaveBeenCalled();

      await writer.write(Uint8Array.of(42));
      expect(writer.end()).toBe(true);
      expect(await reader.read()).toEqual({ kind: 'bytes', frame: Uint8Array.of(42) });
      expect(await reader.read()).toEqual({ kind: 'eof' });
      finishObserver();
      await vi.waitFor(() =>
        expect(joined).toHaveBeenCalledExactlyOnceWith({ kind: 'cleaned-owned' })
      );
      expect(lost).not.toHaveBeenCalled();
    } finally {
      finishObserver();
      for (const stream of [guardian, worker, output, input]) stream.destroy();
    }
  });

  it.each(['missing-join', 'truncated-after-join', 'abnormal-owner'] as const)(
    'does not keep data open on %s even with a delayed report handler',
    async (mode) => {
      const [guardian, worker] = pair();
      const connection = { endpointId: '23'.repeat(16), token: '45'.repeat(32) };
      const send = createControlWriter(
        connection.token,
        connection.endpointId,
        'anchor-to-guardian'
      );
      let finishObserver!: () => void;
      const observer = new Promise<void>((resolve) => {
        finishObserver = resolve;
      });
      const joined = vi.fn();
      const lost = vi.fn();
      try {
        bindWorkerReports(worker, connection, {
          async receive() {
            await observer;
          },
          joined,
          lost,
          retainOutput: () => mode !== 'abnormal-owner',
        });
        guardian.write(send('closed', { native: true }));
        if (mode !== 'missing-join') guardian.write(send('joined', { kind: 'cleaned-owned' }));
        if (mode === 'truncated-after-join') guardian.write(Buffer.from([0]));
        guardian.end();
        await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
        if (mode === 'abnormal-owner')
          expect(joined).toHaveBeenCalledExactlyOnceWith({ kind: 'cleaned-owned' });
        else expect(joined).not.toHaveBeenCalled();
      } finally {
        finishObserver();
        guardian.destroy();
        worker.destroy();
      }
    }
  );

  it('forwards actual EOF after the reader drains initial and final output', async () => {
    const [outgoing, incoming] = pair();
    const source = new PassThrough();
    try {
      const reader = socketLaneReader(incoming);
      const forwarding = forwardOutput(source, socketLaneWriter(outgoing));
      source.write(Uint8Array.of(42));
      expect(await reader.read()).toEqual({ kind: 'bytes', frame: Uint8Array.of(42) });
      source.end(Uint8Array.of(43));
      expect(await reader.read()).toEqual({ kind: 'bytes', frame: Uint8Array.of(43) });
      expect(await reader.read()).toEqual({ kind: 'eof' });
      await expect(forwarding).resolves.toBe(true);
    } finally {
      source.destroy();
      outgoing.destroy();
      incoming.destroy();
    }
  });

  it('does not turn output socket loss into EOF even if native source ends later', async () => {
    const [outgoing, incoming] = pair();
    const source = new PassThrough();
    try {
      const reader = socketLaneReader(incoming);
      const forwarding = forwardOutput(source, socketLaneWriter(outgoing));
      source.write(Uint8Array.of(42));
      expect(await reader.read()).toEqual({ kind: 'bytes', frame: Uint8Array.of(42) });
      outgoing.end();
      expect(await reader.read()).toMatchObject({ kind: 'error' });
      source.end();
      await expect(forwarding).resolves.toBe(false);
    } finally {
      source.destroy();
      outgoing.destroy();
      incoming.destroy();
    }
  });

  it('keeps truncated stream transport separate from native EOF', async () => {
    const [outgoing, incoming] = pair();
    try {
      const reader = socketLaneReader(incoming);
      outgoing.end(Buffer.from([1, 0, 0, 0, 5, 42]));
      expect(await reader.read()).toMatchObject({ kind: 'error' });
    } finally {
      outgoing.destroy();
      incoming.destroy();
    }
  });
});
