/** Private guardian executable. Main stdin and worker control are separate owners. */
import { createTerminalCleanupReceipt } from './terminal-cleanup-receipt.mjs';
import { createServer } from 'node:net';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { createControlReader, createControlWriter } from './control.mjs';
import { openGuardianAnchor } from './guardian-anchor.mjs';
import {
  authLine,
  readAuthLine,
  requirePrivateSocketDirectory,
  SCOPE_ROLES,
  socketPath,
  verifyLine,
} from './scope-auth.mjs';
import { forwardInput, forwardOutput, socketLaneReader, socketLaneWriter } from './socket-lane.mjs';

function notify(fact) {
  if (!process.stdout.destroyed) process.stdout.write(`${fact}\n`);
}

async function awaitOutputReports(work, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  let timer;
  try {
    await Promise.race([
      work(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function guardian(directory, endpointId, observer, publishTerminal = () => false) {
  const main = new globalThis.AbortController();
  const scope = new globalThis.AbortController();
  const accepted = new Map();
  const sockets = new Set();
  let connection;
  let control;
  let request;
  let grace;
  let anchor;
  let output;
  let started = false;
  let awaitingPrepared = false;
  let closing;
  let reports = Promise.resolve();

  function stop(deadline = Date.now() + 5_000, preserveOutput = false) {
    // Loss paths never depend on a worker remaining available to drain output.
    if (!preserveOutput) {
      for (const [role, socket] of accepted) if (role !== 'control') socket.destroy();
    }
    if (closing) return closing;
    const cap = Math.min(deadline, Date.now() + 5_000);
    accepted.get('stdin')?.destroy();
    closing = Promise.resolve()
      .then(async () => {
        const receipt = anchor ? await anchor.stopAndJoin(cap) : { kind: 'never-acquired' };
        if (preserveOutput && output) {
          // Active worker drains can still observe genuine native EOF during an
          // explicit stop. A stalled or failed lane cannot extend ownership.
          await awaitOutputReports(async () => {
            await output;
            await reports;
          }, cap);
        }
        // The parent has the real guardian wait as separate evidence.
        notify(receipt.kind);
        if (control && !control.destroyed) {
          try {
            send('joined', { kind: receipt.kind });
          } catch {
            /* Scope already gone. */
          }
          control.end(() => control.destroy());
        }
        for (const socket of sockets) if (socket !== control) socket.destroy();
        server.close();
        process.stdin.destroy();
        if (receipt.kind === 'cleanup-uncertain') process.exitCode = 2;
        publishTerminal(receipt);
      })
      .catch(() => {
        publishTerminal({ kind: 'cleanup-uncertain' });
        notify('cleanup-uncertain');
        for (const socket of sockets) socket.destroy();
        server.close();
        process.stdin.destroy();
        process.exitCode = 2;
      });
    return closing;
  }

  let send = () => {};
  function scopeLost() {
    if (scope.signal.aborted) return;
    scope.abort();
    notify('scope-ended');
    void stop();
  }

  function observeReport(kind, fact) {
    reports = reports
      .then(async () => {
        if (kind === 'pid') {
          const identity = await anchor?.observeTarget(fact?.pid);
          if (!identity) {
            send('failed', { code: 'native-identity-unobserved' });
            void stop();
          } else if (!closing && !scope.signal.aborted && !main.signal.aborted) {
            send('spawned', identity);
          }
        } else if (kind === 'exit') {
          send('exited', fact);
        } else if (kind === 'child-close') {
          // A direct wait is only one prerequisite of native stream closure.
          if (output && (await output).every(Boolean)) send('closed', { native: true });
        } else {
          send('failed', { code: fact?.code ?? 'spawn-failed' });
          void stop();
        }
      })
      .catch(() => {
        void stop();
      });
  }

  async function prepare() {
    try {
      if (closing || !request || main.signal.aborted || scope.signal.aborted) return;
      anchor = openGuardianAnchor({
        main: main.signal,
        scope: scope.signal,
        observer,
        receive: observeReport,
      });
      if (request.stdio.stdin === 'pipe')
        void forwardInput(socketLaneReader(accepted.get('stdin')), anchor.stdin);
      else anchor.stdin.end();
      output = Promise.all(
        ['stdout', 'stderr'].map((lane) => {
          if (request.stdio[lane] !== 'pipe') {
            anchor[lane].resume();
            return true;
          }
          return forwardOutput(anchor[lane], socketLaneWriter(accepted.get(lane)));
        })
      );
      await anchor.ready(request.deadline);
      if (!closing) {
        awaitingPrepared = true;
        send('prepare');
      }
    } catch {
      send('failed', { code: 'anchor-acquisition-failed' });
      void stop();
    }
  }

  function beginControl() {
    control = accepted.get('control');
    const write = createControlWriter(
      connection.token,
      connection.endpointId,
      'anchor-to-guardian'
    );
    send = (kind, fact = null) => {
      if (!control.destroyed && !control.writableEnded) control.write(write(kind, fact));
    };
    const read = createControlReader(
      connection.token,
      connection.endpointId,
      'guardian-to-anchor',
      (kind, payload) => {
        if (kind === 'stop' && Number.isSafeInteger(payload?.deadline)) {
          void stop(payload.deadline, true);
          return;
        }
        if (closing) return;
        if (
          kind === 'launch' &&
          !request &&
          payload?.request?.stdio &&
          Number.isSafeInteger(payload.grace) &&
          payload.grace >= 0 &&
          payload.grace <= 3_000
        ) {
          request = payload.request;
          grace = payload.grace;
          void prepare();
        } else if (kind === 'prepared' && awaitingPrepared && !started) {
          started = true;
          void anchor.authorize(request, grace).catch(() => {
            send('failed', { code: 'anchor-authorization-failed' });
            void stop();
          });
        } else if (kind === 'observer-failed') {
          void stop();
        } else {
          scopeLost();
        }
      }
    );
    control.on('data', (bytes) => {
      try {
        read.push(bytes);
      } catch {
        scopeLost();
      }
    });
    control.on('end', () => {
      try {
        read.end();
      } catch {
        /* Closing due to control loss. */
      }
      scopeLost();
    });
    control.on('close', scopeLost);
    control.resume();
    notify('scope-connected');
  }

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => {
      if (socket === control) scopeLost();
      socket.destroy();
    });
    socket.once('close', () => sockets.delete(socket));
    void readAuthLine(socket, main.signal).then(
      (line) => {
        const role = verifyLine(connection, line, 'claim');
        if (!role || accepted.has(role) || closing || socket.destroyed) {
          socket.destroy();
          return;
        }
        accepted.set(role, socket);
        socket.write(authLine(connection, role, 'accepted'));
        if (accepted.size === SCOPE_ROLES.length) {
          if ([...accepted.values()].some((peer) => peer.destroyed)) scopeLost();
          else beginControl();
        }
      },
      () => socket.destroy()
    );
  });
  server.once('error', () => {
    void stop();
  });

  process.stdin.once('end', () => {
    main.abort();
    void stop();
  });
  process.stdin.once('error', () => {
    main.abort();
    void stop();
  });
  const token = await readAuthLine(process.stdin, main.signal).catch(() => undefined);
  if (!token || !/^[a-f0-9]{64}$/.test(token) || main.signal.aborted) {
    await stop();
    return;
  }
  connection = { token, endpointId };
  process.stdin.on('data', () => {
    main.abort();
    void stop();
  });
  process.stdin.resume();
  await requirePrivateSocketDirectory(directory);
  if (main.signal.aborted || closing) return;
  server.listen(socketPath(directory, endpointId), () => notify('ready'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.on('error', () => undefined);
  const publishTerminal = createTerminalCleanupReceipt(
    process.argv[5] === '--fixture-terminal-cleanup-fd=3' ? 3 : undefined
  );
  void guardian(process.argv[2], process.argv[3], process.argv[4], publishTerminal).catch(() => {
    publishTerminal({ kind: 'cleanup-uncertain' });
    notify('cleanup-uncertain');
    process.stdin.destroy();
    process.exitCode = 2;
  });
}
