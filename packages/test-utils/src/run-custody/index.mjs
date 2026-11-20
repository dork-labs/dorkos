import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { createByteLane } from './byte-lane.mjs';

export { createByteLane, MAX_FRAME_BYTES, MAX_LANE_CREDIT } from './byte-lane.mjs';
export { createRunAuthority } from './lifelines.mjs';

/** Resolve an asset relative to this private export, independent of process.cwd(). */
export function custodyAsset(name) {
  if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(name))
    throw new Error('Invalid custody asset name');
  return new URL(name, import.meta.url);
}

function latch() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  let settled = false;
  return {
    promise,
    get settled() {
      return settled;
    },
    set(value) {
      if (settled) return false;
      settled = true;
      resolve(value);
      return true;
    },
  };
}

function bounded(work, deadline, expired) {
  if (!Number.isFinite(deadline)) throw new RangeError('A finite custody deadline is required');
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(expired), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A rejected start retains structured failure facts outside enumerable receipt data. */
export class RunStartError extends Error {
  constructor(outcome) {
    super(`Custody start failed (${outcome.kind})`);
    this.name = 'RunStartError';
    Object.defineProperty(this, 'outcome', { value: outcome });
  }
}

/** A secret-free receipt summary. Native observations stay on the child port. */
export function custodyReceipt(outcome) {
  switch (outcome.kind) {
    case 'never-acquired':
    case 'interrupted':
    case 'spawn-failed':
    case 'native-closed':
    case 'cleaned-owned':
    case 'unsupported':
    case 'cleanup-uncertain':
      return { kind: outcome.kind };
    default:
      throw new Error('Invalid custody receipt outcome');
  }
}

/**
 * A private, inert port around an authenticated backend endpoint. The backend
 * registers its stop action before acquiring resources. It is responsible for
 * obeying cancellation and reporting integrity at the native boundaries.
 * Launch must finish after startup negotiation, independently of data lanes.
 */
export function createRunSpawnPort({ authority, main, scope, launch, cleanupMs }) {
  if (!Number.isFinite(cleanupMs) || cleanupMs < 0)
    throw new RangeError('A finite custody cleanup budget is required');
  return {
    async start(request, signal) {
      const lifelines = [...authority.signals(main, scope), signal];
      if (lifelines.some((line) => line.aborted))
        throw new RunStartError({ kind: 'never-acquired', reason: 'owner-lost' });
      if (request.deadline !== undefined && !Number.isFinite(request.deadline))
        throw new RangeError('A finite custody startup deadline is required');
      if (request.deadline !== undefined && request.deadline <= Date.now())
        throw new RunStartError({ kind: 'never-acquired', reason: 'deadline' });
      return runScope(request, lifelines, cleanupMs, () =>
        authority.acquireScope(main, scope)
      ).acquire(launch);
    },
  };
}

function runScope(request, lifelines, cleanupMs, acquireScope) {
  const controller = new globalThis.AbortController();
  const deadline = request.deadline;
  const stdin = request.stdio.stdin === 'pipe' ? createByteLane() : undefined;
  const stdout = request.stdio.stdout === 'pipe' ? createByteLane() : undefined;
  const stderr = request.stdio.stderr === 'pipe' ? createByteLane() : undefined;
  const releaseScope = acquireScope();
  const spawn = latch(),
    exit = latch(),
    close = latch(),
    cancelled = latch();
  let ownership;
  let stopping;
  let identity;
  let transportLost = false;
  let accepting = true;

  const release = () => {
    for (const line of lifelines) line.removeEventListener('abort', ownerLoss);
  };
  const stopAndJoin = (reason, deadline) => {
    if (!Number.isFinite(deadline)) throw new RangeError('A finite custody deadline is required');
    if (stopping) return stopping;
    accepting = false;
    const uncertain = { kind: 'cleanup-uncertain', reason: 'deadline' };
    stopping = Promise.resolve()
      .then(async () => {
        if (!ownership) return { kind: 'never-acquired', reason };
        try {
          const outcome = await bounded(
            Promise.resolve(ownership(reason, deadline)),
            deadline,
            uncertain
          );
          return outcome?.kind === 'cleaned-owned' || outcome?.kind === 'cleanup-uncertain'
            ? outcome
            : { kind: 'cleanup-uncertain', reason: 'invalid-backend-cleanup' };
        } catch (error) {
          return { kind: 'cleanup-uncertain', reason: 'backend-error', error };
        }
      })
      .then((outcome) => {
        spawn.set({ kind: 'unobserved' });
        exit.set({ kind: 'unobserved' });
        close.set({ kind: 'unobserved' });
        release();
        releaseScope(outcome.kind === 'cleanup-uncertain');
        return outcome;
      });
    controller.abort();
    const streamError = new Error('Custody stream ended before delivery');
    stdin?.abandon(streamError);
    stdout?.abandon(streamError);
    stderr?.abandon(streamError);
    return stopping;
  };
  const cancel = (reason) => {
    cancelled.set(reason);
    void stopAndJoin(reason, Date.now() + cleanupMs);
  };
  const ownerLoss = () => cancel('owner-lost');
  for (const line of lifelines) line.addEventListener('abort', ownerLoss, { once: true });

  const endpoint = {
    signal: controller.signal,
    stdin: stdin?.reader,
    stdout: stdout?.writer,
    stderr: stderr?.writer,
    own(stop) {
      if (!accepting || ownership || typeof stop !== 'function')
        throw new Error('Custody ownership unavailable');
      ownership = stop;
    },
    spawned(fact) {
      if (
        !ownership ||
        !accepting ||
        !Number.isSafeInteger(fact.pid) ||
        fact.pid <= 0 ||
        typeof fact.executable !== 'string' ||
        fact.executable.length === 0
      )
        return false;
      if (identity) return false;
      identity = Object.freeze({ pid: fact.pid, executable: fact.executable, birth: fact.birth });
      return spawn.set({ kind: 'spawned', ...identity });
    },
    exited(fact) {
      return (
        Boolean(identity) &&
        !close.settled &&
        exit.set({ code: fact.code, signal: fact.signal, kind: 'exited' })
      );
    },
    closed(fact) {
      if (!identity || close.settled) return false;
      return close.set({ integrity: fact.integrity, kind: 'native-closed' });
    },
    lost() {
      if (transportLost) return false;
      transportLost = true;
      close.set({ kind: 'transport-lost' });
      cancel('transport-lost');
      return true;
    },
  };

  return {
    async acquire(launch) {
      const work = Promise.resolve()
        .then(() => {
          if (!accepting) return;
          if (deadline !== undefined && deadline <= Date.now()) {
            cancel('deadline');
            return;
          }
          return launch(request, endpoint);
        })
        .then(
          (outcome) => ({ completed: true, outcome }),
          (error) => ({ completed: false, error })
        );
      const attempt = Promise.race([work, cancelled.promise.then((reason) => ({ reason }))]);
      const result =
        deadline === undefined
          ? await attempt
          : await bounded(attempt, deadline, { reason: 'deadline' });
      const expired = deadline !== undefined && deadline <= Date.now();
      if ('reason' in result || cancelled.settled || expired) {
        const reason =
          'reason' in result
            ? result.reason
            : cancelled.settled
              ? await cancelled.promise
              : 'deadline';
        const cleanup = await stopAndJoin(reason, Date.now() + cleanupMs);
        throw new RunStartError({
          kind: ownership ? 'interrupted' : 'never-acquired',
          reason,
          cleanup,
        });
      }
      if (!result.completed || result.outcome?.kind === 'unsupported' || !identity) {
        const cleanup = await stopAndJoin('acquisition-failed', Date.now() + cleanupMs);
        if (!result.completed)
          throw new RunStartError({ kind: 'spawn-failed', error: result.error, cleanup });
        if (result.outcome?.kind === 'unsupported')
          throw new RunStartError({ kind: 'unsupported', cleanup });
        throw new RunStartError({
          kind: 'spawn-failed',
          error: new Error('Missing native spawn fact'),
          cleanup,
        });
      }
      return {
        ...identity,
        stdin: stdin?.writer,
        stdout: stdout?.reader,
        stderr: stderr?.reader,
        spawn: spawn.promise,
        exit: exit.promise,
        close: close.promise,
        stopAndJoin,
      };
    },
  };
}
