/**
 * Wait for Fly to let go of a Machine before deploying to it again (DOR-2702).
 *
 * `fly deploy` creates a new Machine with a lease that lasts its whole `--wait-timeout` (five
 * minutes by default), and takes a short, refreshed lease on every existing Machine it updates.
 * flyctl v0.4.110 `internal/command/deploy`: `launchInput.LeaseTTL = waitTimeout` for a new
 * Machine; `acquireMachineLease` with `--lease-timeout` (13 s) for an existing one. When a person
 * presses Control-C during a deploy, flyctl is killed before it can release that lease, so Fly keeps
 * the Machine locked until the lease runs out. A resumed `fly deploy` in that window cannot take the
 * lease: fly-go retries the 409 for about a minute, flyctl gives up, and Fly marks the new release
 * `failed`. Seen live on v0.96.0: the resume failed after 87 s, and the same command worked once the
 * lease expired, five minutes after the stopped deploy began.
 *
 * So before a deploy to an app that already has Machines, setup reads each Machine's lease and,
 * while one is held, waits for it with a progress line, up to a fixed limit. It never clears a
 * lease: `fly machine leases clear` releases whatever lease it finds, with no check of whose it is,
 * and a lease that is still being refreshed belongs to a deploy that is still running, which may be
 * the person's own from another terminal. Waiting is always safe; clearing is not.
 *
 * Lives under `runtime/` because `community-deploy/` is at the repository's per-directory file
 * limit (`scripts/check-dir-size.sh`).
 *
 * @module commands/community-deploy/runtime/fly-lease
 */
import { z } from 'zod';
import { ExternalIdentifierSchema, parseExternalJson } from '../provider-contract.js';
import { ProviderCommandError, runProviderCommand } from '../provider-process.js';
import { ProviderMutationError } from '../provider-mutation.js';
import type { FlySessionReadOptions } from '../tigris-session.js';

/**
 * The longest setup waits for a held lease: flyctl's default `--wait-timeout` of five minutes,
 * which is the longest lease a stopped deploy leaves, plus one minute for clocks and slow answers.
 */
export const FLY_LEASE_WAIT_LIMIT_MS = 6 * 60_000;

/** How often a held lease is read again while setup waits. */
export const FLY_LEASE_POLL_MS = 15_000;

/** How often the progress line is repeated while setup waits. */
const PROGRESS_EVERY_MS = 60_000;

/** A lease Fly reports on one Machine; only when it ends is read, never its owner or nonce. */
export type FlyMachineLease = { expiresAtMs: number | null } | null;

/**
 * `fly machine leases view <id> --app <app> --json`: an object keyed by Machine id, empty when the
 * Machine has no lease (flyctl skips Fly's "lease not found"). Each value is fly-go's
 * `MachineLease`, whose `data.expires_at` is Unix seconds.
 */
const FlyLeaseViewSchema = z.record(
  ExternalIdentifierSchema,
  z
    .object({
      data: z
        .object({ expires_at: z.number().int().nonnegative().optional() })
        .passthrough()
        .nullish(),
    })
    .passthrough()
    .nullable()
);

/**
 * Read the lease on one Machine of one app.
 *
 * @param options - Pinned Fly executable and bounded process settings.
 * @param appName - The app setup created.
 * @param machineId - One of its Machines.
 * @returns When the lease ends (null when Fly gives no time), or null when there is none.
 */
export async function readFlyMachineLease(
  options: FlySessionReadOptions,
  appName: string,
  machineId: string
): Promise<FlyMachineLease> {
  const app = ExternalIdentifierSchema.parse(appName);
  const machine = ExternalIdentifierSchema.parse(machineId);
  return (
    await runProviderCommand({
      ...options,
      args: ['machine', 'leases', 'view', machine, '--app', app, '--json'],
      parse: (stdout): FlyMachineLease => {
        const lease = FlyLeaseViewSchema.parse(parseExternalJson(stdout))[machine];
        if (!lease) return null;
        const expiresAt = lease.data?.expires_at;
        return { expiresAtMs: expiresAt === undefined ? null : expiresAt * 1000 };
      },
    })
  ).value;
}

/**
 * Fly still holds one of the app's Machines for another deploy, so setup will not deploy over it
 * yet. Says when to try again; names only the app, never the lease's owner. The holder is usually
 * the deploy a person just stopped, but may be one still running, so the text does not say which.
 */
export class FlyMachineBusyError extends ProviderMutationError {
  /**
   * Create the refusal for one app.
   *
   * @param appName - The Fly app setup created.
   * @param minutes - Roughly how long until Fly lets go, when known.
   */
  constructor(appName: string, minutes: number | null) {
    super('PROVIDER_UNAVAILABLE');
    this.name = 'FlyMachineBusyError';
    this.message =
      `Fly is still holding the Machine of ${appName} for another deploy, so setup did not deploy over it. ` +
      (minutes === null
        ? 'Wait a few minutes, then run the resume command above again.'
        : `Wait about ${minutesText(minutes)}, then run the resume command above again.`);
  }
}

function minutesText(minutes: number): string {
  return minutes <= 1 ? '1 minute' : `${minutes} minutes`;
}

function minutesUntil(endMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((endMs - nowMs) / 60_000));
}

/** Everything the wait needs, so tests can drive it with a fake Fly and a fake clock. */
export interface FlyLeaseWaitOptions {
  /** The app setup created; named in the progress line and the refusal. */
  appName: string;
  /** Every Machine the app has right now. */
  machineIds: readonly string[];
  /** Read one Machine's lease (see {@link readFlyMachineLease}). */
  readLease(machineId: string): Promise<FlyMachineLease>;
  /** Write one progress line. */
  progress(line: string): void;
  /** Wall clock in milliseconds. */
  now(): number;
  /** Wait this long, or reject when setup is cancelled. */
  sleep(ms: number): Promise<void>;
  /** The longest to wait; {@link FLY_LEASE_WAIT_LIMIT_MS} by default. */
  limitMs?: number;
}

/**
 * Wait until no Machine of the app is leased, so the next `fly deploy` can take it.
 *
 * Returns at once when nothing is leased, which is every first deploy (no Machine yet). A lease
 * that already ends after the limit stops setup straight away with a plain time to try again; one
 * still held when the limit passes (a deploy that keeps refreshing it) stops setup then. A
 * lease that cannot be read is not waited for: the deploy then runs exactly as it did before this
 * check existed, and fails on its own if the Machine is still locked. Cancellation propagates.
 *
 * @param options - The app, its Machines, and the injected reader, clock and progress line.
 */
export async function waitForFlyMachineLeases(options: FlyLeaseWaitOptions): Promise<void> {
  const limitMs = options.limitMs ?? FLY_LEASE_WAIT_LIMIT_MS;
  const started = options.now();
  const deadline = started + limitMs;
  let lastProgress: number | null = null;
  for (;;) {
    const ends = await latestLeaseEnd(options);
    if (ends === undefined) {
      if (lastProgress !== null) options.progress('Fly has let go of the Machine. Deploying now…');
      return;
    }
    const now = options.now();
    // Only a lease that already runs past the limit when first seen gets a time to retry; one that
    // is renewed while setup waits belongs to a deploy still running, whose end nobody knows.
    if (lastProgress === null && ends !== null && ends > deadline) {
      throw new FlyMachineBusyError(options.appName, minutesUntil(ends, now));
    }
    if (now >= deadline) throw new FlyMachineBusyError(options.appName, null);
    if (lastProgress === null) {
      // Usually the deploy that was just stopped, but it may be one still running: say neither.
      options.progress(
        `Fly is still holding the Machine of ${options.appName} for another deploy. ` +
          (ends === null
            ? 'Waiting for Fly to let go of it…'
            : `Waiting up to about ${minutesText(minutesUntil(ends, now))} for Fly to let go of it…`)
      );
      lastProgress = now;
    } else if (now - lastProgress >= PROGRESS_EVERY_MS) {
      options.progress('Still waiting for Fly to let go of the Machine…');
      lastProgress = now;
    }
    // Read again just after the lease should end, at least a second apart, never past the limit.
    const untilEnd = ends === null ? FLY_LEASE_POLL_MS : ends - now + 2_000;
    await options.sleep(
      Math.min(deadline - now, Math.max(1_000, Math.min(untilEnd, FLY_LEASE_POLL_MS)))
    );
  }
}

/**
 * The latest end of any held lease: undefined when none is held (or none could be read), null when
 * one is held with no end Fly reported.
 */
async function latestLeaseEnd(options: FlyLeaseWaitOptions): Promise<number | null | undefined> {
  let latest: number | null | undefined;
  for (const machineId of options.machineIds) {
    let lease: FlyMachineLease;
    try {
      lease = await options.readLease(machineId);
    } catch (error) {
      if (error instanceof ProviderCommandError && error.code === 'CANCELLED') throw error;
      continue;
    }
    if (!lease) continue;
    // A lease whose end has passed is no longer held; Fly drops it on the next read.
    if (lease.expiresAtMs !== null && lease.expiresAtMs <= options.now()) continue;
    if (lease.expiresAtMs === null || latest === null) latest = null;
    else latest = latest === undefined ? lease.expiresAtMs : Math.max(latest, lease.expiresAtMs);
  }
  return latest;
}

/**
 * Whether any Machine of the app is leased right now, used to explain a deploy that failed. A
 * lease that cannot be read counts as none, so the deploy's own error is kept.
 *
 * @param options - The app's Machines, the reader and the clock.
 * @returns How long until the lease ends, in whole minutes (null when unknown), or false.
 */
export async function heldLeaseMinutes(
  options: Pick<FlyLeaseWaitOptions, 'machineIds' | 'readLease' | 'now'>
): Promise<number | null | false> {
  const ends = await latestLeaseEnd({
    ...options,
    appName: '',
    progress: () => undefined,
    sleep: async () => undefined,
  }).catch(() => undefined);
  if (ends === undefined) return false;
  return ends === null ? null : minutesUntil(ends, options.now());
}

/**
 * Sleep that ends early, with the same cancellation error a provider command gives, when setup is
 * cancelled.
 *
 * @param ms - How long to wait.
 * @param signal - Setup's cancellation.
 */
export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderCommandError('CANCELLED'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderCommandError('CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
