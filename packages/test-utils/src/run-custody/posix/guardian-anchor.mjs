/** Guardian's owned process handle for one detached anchor. No host process sweep. */
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { createControlReader, createControlWriter } from './control.mjs';
import {
  confirmAnchor,
  observeClosedGroup,
  observeLinuxIdentity,
  queryGroupPresence,
} from './identity.mjs';
import { observeDarwinIdentity } from './darwin-observer.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function until(promise, deadline) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Open the anchor after gating. The caller must be the guardian process,
 * holding physical main and worker channels and projecting close into signals.
 */
export function openGuardianAnchor({ main, scope, observer, receive }) {
  if (main === scope || main.aborted || scope.aborted)
    throw new Error('Independent live POSIX owner lifelines are required');
  if (
    !['linux', 'darwin'].includes(process.platform) ||
    (process.platform === 'darwin' && !observer)
  )
    throw new Error('POSIX native identity observer unavailable');

  const key = randomBytes(32).toString('hex');
  const channel = randomBytes(16).toString('hex');
  const executable = fileURLToPath(new URL('./anchor.mjs', import.meta.url));
  const anchorProcess = spawn(process.execPath, observer ? [executable, observer] : [executable], {
    detached: true,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    env: {},
  });
  const [, , , control, report, stdin, stdout, stderr, bootstrap] = anchorProcess.stdio;
  const online = deferred();
  const closed = deferred();
  const send = createControlWriter(key, channel, 'guardian-to-anchor');
  let anchor;
  let authorized = false;
  let firstReport = true;
  let closing;
  const closeOnLoss = () => {
    void stopAndJoin(Date.now() + 5_000);
  };
  const decode = createControlReader(key, channel, 'anchor-to-guardian', (kind, payload) => {
    if (firstReport) {
      firstReport = false;
      if (kind !== 'online') throw new Error('Missing owned POSIX anchor identity');
      anchor = confirmAnchor(payload, anchorProcess.pid, process.pid);
      online.resolve(anchor);
      if (!anchor) closeOnLoss();
      return;
    }
    if (!authorized || !['pid', 'spawn-failed', 'exit', 'child-close'].includes(kind))
      throw new Error('Unexpected POSIX anchor report');
    receive(kind, payload);
  });
  report.on('data', (bytes) => {
    try {
      decode.push(bytes);
    } catch {
      closeOnLoss();
    }
  });
  report.once('end', () => {
    try {
      decode.end();
    } catch {
      /* A partial report cannot establish a native fact. */
    }
    closeOnLoss();
  });
  for (const pipe of [control, report, bootstrap]) pipe.on('error', closeOnLoss);
  anchorProcess.once('error', () => {
    online.resolve();
  });
  anchorProcess.once('close', (code, signal) => {
    online.resolve();
    closed.resolve({ code, signal });
    main.removeEventListener('abort', closeOnLoss);
    scope.removeEventListener('abort', closeOnLoss);
  });
  main.addEventListener('abort', closeOnLoss, { once: true });
  scope.addEventListener('abort', closeOnLoss, { once: true });
  bootstrap.end(`${key}:${channel}`);
  if (main.aborted || scope.aborted) closeOnLoss();

  function stopAndJoin(deadline) {
    if (closing) return closing;
    if (!Number.isSafeInteger(deadline)) throw new RangeError('Invalid POSIX cleanup deadline');
    const cap = Math.min(deadline, Date.now() + 5_000);
    closing = Promise.resolve()
      .then(async () => {
        if (!control.destroyed) {
          if (authorized) control.end(send('stop', { deadline: cap }));
          else control.end();
        }
        const waited = await until(closed.promise, cap);
        if (!waited) return { kind: 'cleanup-uncertain' };
        if (!authorized) return { kind: 'never-acquired', anchorClose: waited };
        return { kind: observeClosedGroup(anchor, true, queryGroupPresence), anchorClose: waited };
      })
      .catch(() => ({ kind: 'cleanup-uncertain' }));
    return closing;
  }

  async function waitForOwned(deadline) {
    if (deadline !== undefined && !Number.isSafeInteger(deadline))
      throw new Error('Invalid POSIX acquisition deadline');
    const owned =
      deadline === undefined ? await online.promise : await until(online.promise, deadline);
    if (
      !owned ||
      closing ||
      main.aborted ||
      scope.aborted ||
      (deadline !== undefined && deadline <= Date.now())
    ) {
      closeOnLoss();
      throw new Error('POSIX anchor authorization was not acquired');
    }
    return owned;
  }

  return {
    stdin,
    stdout,
    stderr,
    anchorClose: closed.promise,
    async ready(deadline) {
      await waitForOwned(deadline);
    },
    async authorize(request, graceMs) {
      if (authorized || closing) throw new Error('POSIX anchor ownership unavailable');
      const owned = await waitForOwned(request.deadline);
      if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 3_000)
        throw new Error('Invalid POSIX anchor grace');
      const { executable, argv, cwd, env, stdio, deadline } = request;
      const lanes = [stdio.stdin, stdio.stdout, stdio.stderr];
      if (!lanes.every((mode) => mode === 'pipe' || mode === 'ignore'))
        throw new Error('POSIX anchor supports only explicit pipe or ignore lanes');
      const frame = send('start', {
        anchor: owned,
        request: { executable, argv, cwd, env, stdio: lanes, deadline },
        graceMs,
      });
      authorized = true;
      control.write(frame);
    },
    async observeTarget(pid) {
      const observed = await (process.platform === 'linux'
        ? observeLinuxIdentity(pid)
        : observeDarwinIdentity(observer, pid));
      if (!observed || !anchor || observed.parent !== anchor.pid || observed.group !== anchor.group)
        return;
      return observed;
    },
    stopAndJoin,
  };
}
