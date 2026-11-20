/** Worker-side POSIX composition. It never obtains the main lifeline writer. */
import { createConnection } from 'node:net';
import { createRunAuthority, createRunSpawnPort } from '../index.mjs';
import { createControlWriter } from './control.mjs';
import {
  authLine,
  readAuthLine,
  requirePrivateSocketDirectory,
  SCOPE_ROLES,
  socketPath,
  verifyLine,
} from './scope-auth.mjs';
import { bindWorkerReports } from './worker-reports.mjs';
import { socketLaneReader, socketLaneWriter } from './socket-lane.mjs';

function latch() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Authenticate one worker scope, independently of the resource-owning main. */
export async function connectPosixScope({ directory, connection, signal, graceMs = 3_000 }) {
  if (signal.aborted || !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 3_000)
    throw new Error('POSIX scope unavailable');
  await requirePrivateSocketDirectory(directory);
  const pathname = socketPath(directory, connection.endpointId);
  const sockets = new Map();
  const guardian = new globalThis.AbortController();
  const worker = new globalThis.AbortController();
  const joined = latch();
  let receive = () => {};
  let ended = false;
  let explicitStop = false;

  function close() {
    if (ended) return;
    ended = true;
    worker.abort();
    for (const socket of sockets.values()) socket.destroy();
    signal.removeEventListener('abort', close);
  }
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) throw new Error('POSIX scope cancelled');
    await Promise.all(
      SCOPE_ROLES.map(async (role) => {
        const socket = createConnection({ path: pathname, allowHalfOpen: true });
        sockets.set(role, socket);
        socket.on('error', () => {
          if (role === 'control') guardian.abort();
          socket.destroy();
        });
        const ready = readAuthLine(socket, worker.signal);
        socket.once('connect', () => socket.write(authLine(connection, role, 'claim')));
        if (verifyLine(connection, await ready, 'accepted') !== role)
          throw new Error('POSIX scope authentication refused');
      })
    );
    if (
      signal.aborted ||
      worker.signal.aborted ||
      guardian.signal.aborted ||
      [...sockets.values()].some(
        (socket) => socket.destroyed || socket.readableEnded || socket.writableEnded
      )
    )
      throw new Error('POSIX scope closed during authentication');
  } catch (error) {
    close();
    throw error;
  }

  const control = sockets.get('control');
  function lost() {
    joined.resolve({ kind: 'cleanup-uncertain', reason: 'guardian-transport-lost' });
    guardian.abort();
    close();
  }
  const write = createControlWriter(connection.token, connection.endpointId, 'guardian-to-anchor');
  const send = (kind, fact = null) => {
    if (control.destroyed || control.writableEnded)
      throw new Error('POSIX scope control unavailable');
    control.write(write(kind, fact));
  };
  bindWorkerReports(control, connection, {
    receive: (kind, fact) => receive(kind, fact),
    joined: joined.resolve,
    lost,
    retainOutput: () => explicitStop && !signal.aborted && !ended,
  });

  const authority = createRunAuthority();
  const main = authority.openMain(guardian.signal);
  const scope = authority.openScope(main, worker.signal);
  let requestForWire;
  const underlying = createRunSpawnPort({
    authority,
    main,
    scope,
    cleanupMs: 5_000,
    async launch(_local, endpoint) {
      const { executable, argv, cwd, env, stdio, deadline, observer } = requestForWire;
      const started = latch();
      let prepared = false;
      let ready = false;
      endpoint.own((_reason, at) => {
        try {
          send('stop', { deadline: at });
        } catch {
          lost();
        }
        return joined.promise;
      });
      const stopPending = () => started.reject(new Error('POSIX scope closed before native spawn'));
      endpoint.signal.addEventListener('abort', stopPending, { once: true });

      receive = async (kind, fact) => {
        try {
          if (kind === 'prepare' && !prepared) {
            if (endpoint.signal.aborted) return;
            await observer?.beforeSpawn?.(executable);
            if (endpoint.signal.aborted) return;
            prepared = true;
            send('prepared');
          } else if (kind === 'spawned' && prepared && !ready) {
            await observer?.onSpawn(fact);
            if (!endpoint.spawned(fact)) throw new Error('POSIX native spawn observation refused');
            ready = true;
            started.resolve();
          } else if (kind === 'exited' && ready) {
            endpoint.exited(fact);
          } else if (kind === 'closed' && ready && fact?.native === true) {
            let integrity = 'unobserved';
            if (observer) {
              try {
                await observer.onClose({ integrity: 'unobserved' });
                integrity = 'verified';
              } catch {
                integrity = 'failed';
              }
            }
            endpoint.closed({ integrity });
          } else if (kind === 'failed') {
            throw new Error('POSIX guardian could not start the observed target');
          } else {
            throw new Error('Unexpected POSIX guardian observation');
          }
        } catch (error) {
          started.reject(error);
          try {
            send('observer-failed');
          } catch {
            lost();
          }
          if (ready) endpoint.lost();
        }
      };
      try {
        send('launch', {
          request: { executable, argv, cwd, env, stdio, deadline },
          grace: graceMs,
        });
        await started.promise;
      } finally {
        endpoint.signal.removeEventListener('abort', stopPending);
      }
    },
  });

  const port = {
    async start(request, signal) {
      if (requestForWire) throw new Error('POSIX scope is single-use');
      requestForWire = request;
      const { stdin, stdout, stderr } = request.stdio;
      const lanes = {
        stdin: stdin === 'pipe' ? socketLaneWriter(sockets.get('stdin')) : undefined,
        stdout: stdout === 'pipe' ? socketLaneReader(sockets.get('stdout')) : undefined,
        stderr: stderr === 'pipe' ? socketLaneReader(sockets.get('stderr')) : undefined,
      };
      // Only the socket owns data credit. The shared port retains authoritative
      // spawn, exit, close and cleanup outcomes without a second data queue.
      const child = await underlying.start(
        {
          ...request,
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        },
        signal
      );
      return {
        ...child,
        ...lanes,
        stopAndJoin(reason, deadline) {
          explicitStop = true;
          return child.stopAndJoin(reason, deadline);
        },
      };
    },
  };
  return { port, close };
}
