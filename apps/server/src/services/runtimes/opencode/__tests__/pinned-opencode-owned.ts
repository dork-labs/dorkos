/** Pinned fixture adapter for an explicitly supplied, native-observing custody port. */
import { realpathSync, statSync } from 'node:fs';
import {
  RunStartError,
  type Cleanup,
  type NativeIdentity,
  type RunChild,
  type RunRequest,
  type RunSpawnPort,
} from '@dorkos/test-utils/run-custody';
import { WorkerCleanupError } from './custody/worker.js';
import {
  OPENCODE_PIN,
  pinnedOpenCode,
  pinnedOpenCodeEnvironment,
  sha256Of,
} from './pinned-opencode.js';

interface BinaryPin {
  executable: string;
  sha256: string;
}
type OwnedPinnedChild = RunChild & { verified: Promise<void> };

function officialPin(): BinaryPin {
  const executable = pinnedOpenCode();
  if (!executable) throw new Error('No pinned OpenCode binary for this platform');
  return { executable, sha256: OPENCODE_PIN.sha256[`${process.platform}-${process.arch}`]! };
}

function observePin(pin: BinaryPin) {
  const canonical = realpathSync(pin.executable);
  const selected = statSync(canonical, { bigint: true });
  let phase: 'selected' | 'pre' | 'spawned' | 'post' | 'failed' = 'selected';
  let identity: NativeIdentity | undefined;
  const requirePhase = (expected: typeof phase) => {
    if (phase !== expected) {
      phase = 'failed';
      throw new Error('Pinned OpenCode observation arrived out of order');
    }
  };
  const verify = (executable: string) => {
    try {
      if (realpathSync(executable) !== canonical) throw new Error('Unexpected native executable');
      const current = statSync(canonical, { bigint: true });
      if (current.dev !== selected.dev || current.ino !== selected.ino)
        throw new Error('Pinned OpenCode executable identity changed');
      if (sha256Of(canonical) !== pin.sha256) throw new Error('Pinned OpenCode SHA-256 changed');
    } catch (error) {
      phase = 'failed';
      throw error;
    }
  };

  return {
    observer: {
      beforeSpawn(executable: string) {
        requirePhase('selected');
        verify(executable);
        phase = 'pre';
      },
      onSpawn(fact: NativeIdentity) {
        requirePhase('pre');
        verify(fact.executable);
        if (!Number.isSafeInteger(fact.pid) || fact.pid <= 0) {
          phase = 'failed';
          throw new Error('Pinned OpenCode native identity is missing');
        }
        identity = { ...fact };
        phase = 'spawned';
      },
      onClose() {
        requirePhase('spawned');
        verify(canonical);
        phase = 'post';
      },
    },
    async checkSpawn(child: RunChild) {
      const spawn = await child.spawn;
      if (
        (phase !== 'spawned' && phase !== 'post') ||
        !identity ||
        identity.pid !== spawn.pid ||
        identity.pid !== child.pid ||
        identity.executable !== spawn.executable ||
        identity.executable !== child.executable ||
        identity.birth !== spawn.birth ||
        identity.birth !== child.birth
      )
        throw new Error('Pinned OpenCode PRE and native spawn identity were not observed');
    },
    async checkClose(child: RunChild) {
      const close = await child.close;
      if (close.kind !== 'native-closed' || close.integrity !== 'verified' || phase !== 'post')
        throw new Error('Pinned OpenCode POST was not verified at native close');
    },
  };
}

class PinnedCleanupUncertainError extends Error {
  constructor(options?: ErrorOptions) {
    super('Pinned OpenCode cleanup could not be confirmed', options);
  }
}

/** Only actual run-port or worker-scope cleanup evidence retains a fixture. */
export function isPinnedFixtureCleanupUncertain(error: unknown): boolean {
  if (error instanceof PinnedCleanupUncertainError || error instanceof WorkerCleanupError)
    return true;
  if (error instanceof RunStartError) return error.outcome.cleanup?.kind === 'cleanup-uncertain';
  return error instanceof AggregateError && error.errors.some(isPinnedFixtureCleanupUncertain);
}

async function requireOwnedJoin(child: RunChild, reason: string, deadline: number) {
  const cleanup = await Promise.resolve()
    .then(() => child.stopAndJoin(reason, deadline))
    .catch((error: unknown) => {
      throw new PinnedCleanupUncertainError({ cause: error });
    });
  if (cleanup.kind !== 'cleaned-owned') throw new PinnedCleanupUncertainError();
}

/** Add one pin observer per start while leaving the supplied port in charge of custody. */
export function guardPinnedOpenCodePort(
  port: RunSpawnPort,
  selectPin: () => BinaryPin = officialPin
) {
  return {
    async start(request: RunRequest, signal: AbortSignal): Promise<OwnedPinnedChild> {
      const pin = selectPin();
      if (request.executable !== pin.executable) throw new Error('Unexpected OpenCode binary');
      const pinCheck = observePin(pin);
      const child = await port.start(
        { ...request, env: pinnedOpenCodeEnvironment(request.env), observer: pinCheck.observer },
        signal
      );
      try {
        await pinCheck.checkSpawn(child);
      } catch (primary) {
        let cleanup: Cleanup;
        try {
          cleanup = await child.stopAndJoin('pin-spawn-observation-failed', Date.now() + 5_000);
          if (cleanup.kind === 'never-acquired')
            cleanup = { kind: 'cleanup-uncertain', reason: 'owned-child-reported-unacquired' };
        } catch (error) {
          cleanup = { kind: 'cleanup-uncertain', reason: 'backend-error', error };
        }
        throw new RunStartError({ kind: 'spawn-failed', error: primary, cleanup });
      }
      const verified = pinCheck.checkClose(child);
      void verified.catch(() => undefined);
      return { ...child, verified };
    },
  };
}

/** Run an owned raw CLI fixture, ending stdin before work and joining before reporting. */
export async function runOwnedPinnedOpenCode<T>(
  child: OwnedPinnedChild,
  run: (child: RunChild) => Promise<T>
): Promise<T> {
  const errors: unknown[] = [];
  let outcome: { value: T } | undefined;
  try {
    child.stdin?.end();
    outcome = { value: await run(child) };
  } catch (primary) {
    errors.push(primary);
  }
  const [cleanup, integrity] = await Promise.allSettled([
    requireOwnedJoin(child, 'pinned-run-finished', Date.now() + 5_000),
    child.verified,
  ]);
  if (cleanup.status === 'rejected') errors.push(cleanup.reason);
  if (integrity.status === 'rejected') errors.push(integrity.reason);
  if (errors.length > 1)
    throw new AggregateError(errors, 'Pinned OpenCode run did not complete cleanly');
  if (errors.length === 1) throw errors[0];
  return outcome!.value;
}
