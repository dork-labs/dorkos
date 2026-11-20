/** Own a pinned serve attempt independently of the manager's startup signal. */
import { RunStartError, type Cleanup, type LaneReader } from '@dorkos/test-utils/run-custody';
import type { SidecarSpawnPort } from '../sidecar-custody.js';
import { connectPosixWorker } from './custody/posix-endpoint.js';
import type { ProvidedCustody } from './custody/run-main.js';
import { acquireWorkerCustody } from './custody/worker.js';
import {
  guardPinnedOpenCodePort,
  isPinnedFixtureCleanupUncertain,
} from './pinned-opencode-owned.js';

type ScopeChannel = Awaited<ReturnType<typeof connectPosixWorker>>;
type AcquisitionOptions = Parameters<typeof acquireWorkerCustody<ScopeChannel>>[0];

/** Explicit local test edges for worker transport and pin observation. */
export interface PinnedManagerCustodyDependencies {
  /** Acquire an owned worker; the lifecycle helper only consumes its port and close. */
  acquire(options: AcquisitionOptions): Promise<{
    channel: Pick<ScopeChannel, 'port'>;
    close(): Promise<void>;
  }>;
  /** Wrap that same owned port with the existing pinned-child observer. */
  guard: typeof guardPinnedOpenCodePort;
}

function handoff(reader?: LaneReader) {
  let last: ReturnType<LaneReader['read']> | undefined;
  return {
    reader: reader && {
      read() {
        last = reader.read();
        return last;
      },
    },
    async drain() {
      if (!reader) return false;
      // Manager abort means its loop cannot issue another read. Its last
      // pending operation still owns that read and must settle first.
      let value = await last;
      while (!value || value.kind === 'bytes') value = await reader.read();
      return value.kind === 'eof';
    },
  };
}

async function beforeDeadline<T>(checks: Promise<T>, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      checks,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Call only from a fixture whose original native eligibility passed. */
export function createPinnedManagerCustody(
  provided: ProvidedCustody,
  suite: AbortSignal,
  dependencies?: PinnedManagerCustodyDependencies
) {
  const acquire = dependencies?.acquire ?? acquireWorkerCustody;
  const guard = dependencies?.guard ?? guardPinnedOpenCodePort;
  const failures: unknown[] = [];
  let retain = false;

  const port: SidecarSpawnPort = {
    async start(request, manager) {
      if (retain || failures.length)
        throw new Error('Previous pinned serve proof could not be confirmed');
      // Retain resources throughout acquisition and retirement, including when
      // the manager returns before our bounded worker close finishes.
      retain = true;
      const startup = new AbortController();
      const cancel = () => startup.abort();
      manager.addEventListener('abort', cancel, { once: true });
      if (manager.aborted) cancel();
      const owner = AbortSignal.any([suite, startup.signal]);
      let close: (() => Promise<void>) | undefined;
      try {
        const worker = await acquire({
          admitted: true,
          provided,
          signal: owner,
          deadline: request.deadline,
          connect: connectPosixWorker,
        });
        close = worker.close;
        owner.throwIfAborted();
        const child = await guard(worker.channel.port).start(request, owner);
        const stdout = handoff(child.stdout);
        const stderr = handoff(child.stderr);
        let retiring: Promise<Cleanup> | undefined;
        async function retire(reason: string, deadline: number): Promise<Cleanup> {
          // Manager sets its signal before invoking the returned child stop.
          const drains = Promise.allSettled([stdout.drain(), stderr.drain()]);
          const native = await Promise.allSettled([
            child.stopAndJoin(reason, deadline),
            child.verified,
          ]);
          const output = await beforeDeadline(drains, deadline);
          if (
            native[1].status !== 'fulfilled' ||
            !output ||
            output.some((lane) => lane.status !== 'fulfilled' || !lane.value)
          )
            failures.push(new Error('Pinned serve close or output could not be verified'));

          const [released] = await Promise.allSettled([worker.close()]);
          if (released.status === 'rejected') failures.push(released.reason);
          const cleanup = native[0];
          if (
            cleanup.status === 'fulfilled' &&
            cleanup.value.kind === 'cleaned-owned' &&
            released.status === 'fulfilled'
          ) {
            retain = false;
            return cleanup.value;
          }
          if (cleanup.status === 'rejected') failures.push(cleanup.reason);
          return { kind: 'cleanup-uncertain', reason: 'pinned-serve-ownership-unconfirmed' };
        }

        return {
          ...child,
          stdout: stdout.reader,
          stderr: stderr.reader,
          stopAndJoin(reason, deadline) {
            return (retiring ??= retire(reason, deadline));
          },
        };
      } catch (primary) {
        const uncertain = isPinnedFixtureCleanupUncertain(primary);
        const [cleanup] = await Promise.allSettled([close?.()]);
        if (cleanup.status === 'rejected') {
          const failure = new AggregateError(
            [primary, cleanup.reason],
            'Pinned serve acquisition failed'
          );
          failures.push(failure);
          throw new RunStartError({
            kind: 'spawn-failed',
            error: primary,
            cleanup: {
              kind: 'cleanup-uncertain',
              reason: 'pinned-serve-worker-closure',
              error: failure,
            },
          });
        }
        retain = uncertain;
        failures.push(primary);
        throw primary;
      } finally {
        manager.removeEventListener('abort', cancel);
      }
    },
  };

  return {
    port,
    report: () => ({ retain, failures: [...failures] }),
  };
}
