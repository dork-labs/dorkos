/**
 * The uncertain-create removal's own reads, run read-only against the live gate's real launch
 * (DOR-2606).
 *
 * The provenance probes prove the markers come back unchanged. They do not send what
 * `--remove-uncertain` itself sends to find a Tigris bucket (`DorkosListAppTigris` with the app's
 * network and organization and each bucket's `createdAt` and organization), nor the two name reads
 * it relies on (`DorkosAppNameAvailable`, `DorkosFindTigrisByName`). This module records them as
 * non-secret fields for the receipt's `provenance.removal` block, beside the create timings from
 * `community-deploy-live-create-watch.ts`.
 *
 * Nothing here writes to a service. Every read catches its own failure and records a stable code
 * in its place, never provider text, so no read can fail the gate or hold up its cleanup.
 */
import { LaunchJournalSchema } from '../src/commands/community-deploy/journal.js';
import {
  evaluateUncertainResource,
  type PendingIntent,
  type ProbeResult,
  type RemovalProvider,
  type UnprovedReason,
} from '../src/commands/community-deploy/provenance/uncertain-verdict.js';
import {
  describeCreateWindows,
  type CreateWindowObservation,
  type ObservedCreates,
} from './community-deploy-live-create-watch.js';
import type { SignalSource } from './community-deploy-live-hold.js';
import {
  failureCode,
  guardProbeRun,
  probe,
  type Probe,
  type ProbeFailure,
} from './community-deploy-live-provenance.js';

/** How often the after-cleanup name reads are repeated until both names are free. */
export const NAME_RELEASE_INTERVAL_MS = 15_000;
/** How long the after-cleanup name reads wait for both names to be free. */
export const NAME_RELEASE_DEADLINE_MS = 3 * 60_000;
/** Backstop for the after-cleanup reads: their own wait plus two minutes of slow reads. */
export const NAME_RELEASE_GUARD_MS = NAME_RELEASE_DEADLINE_MS + 2 * 60_000;
/** Longest the before-cleanup reads may take before cleanup goes ahead without them. */
export const REMOVAL_READS_DEADLINE_MS = 2 * 60_000;
/** Consecutive failed reads of one name after which it is no longer read. */
export const NAME_READ_FAILURE_LIMIT = 3;
/** How long the after-cleanup guard waits, once it has cancelled the reads, for them to stop. */
const CANCEL_GRACE_MS = 5_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

/**
 * The journal values the removal reads need, picked one by one. Both halves read through this, so
 * a journal whose schema drifted still gets every read it can, and only the verdict (which needs
 * the whole journal) reports `journal:SCHEMA_MISMATCH`.
 */
export interface RemovalJournalNames {
  appName?: string;
  bucketName?: string;
  flyOrganization?: string;
  flyNetwork?: string;
  tigrisBucketId?: string;
}

/**
 * Pick the values the removal reads need from a journal, without a whole-journal parse.
 *
 * @param journal - The run's journal as read from disk.
 */
export function readRemovalJournalNames(journal: unknown): RemovalJournalNames {
  const root = isRecord(journal) ? journal : {};
  const context = isRecord(root.recoveryContext) ? root.recoveryContext : {};
  const resources = isRecord(root.resources) ? root.resources : {};
  const provenance = isRecord(root.provenance) ? root.provenance : {};
  const names: RemovalJournalNames = {
    appName: identifier(context.appName),
    bucketName: identifier(context.bucketName),
    flyOrganization: identifier(context.flyOrganization),
    flyNetwork: identifier(provenance.flyNetwork),
    tigrisBucketId: identifier(resources.tigrisBucketId),
  };
  return Object.fromEntries(
    Object.entries(names).filter(([, value]) => value !== undefined)
  ) as RemovalJournalNames;
}

/** What `DorkosListAppTigris`, read through the removal's own probe, showed about the live run. */
export interface ListAppTigrisObservation {
  appFound: boolean;
  appNameMatchesJournal: boolean;
  /** The app's private network as read; the marker, not a secret. */
  network: string | null;
  networkMatchesJournal: boolean;
  organizationMatchesJournal: boolean;
  totalCount: number | null;
  listedCount: number | null;
  /** Whether every add-on Fly counted came back in the one page. */
  complete: boolean;
  /** The journaled bucket, found by its exact id in the list, or `null` when it is not listed. */
  journaledBucket: {
    nameMatchesJournal: boolean;
    organizationMatchesJournal: boolean;
    createdAt: string;
  } | null;
  /**
   * What the removal would decide from this read, given the gate's observed `requestedAt` for the
   * bucket. A healthy run is `proved`. Needs the whole journal, so a journal whose schema drifted
   * reads `journal:SCHEMA_MISMATCH` here while the fields above are still recorded.
   */
  verdict:
    | {
        ok: true;
        result: 'proved' | 'absent' | 'unproved' | 'unreachable';
        unprovedReason: UnprovedReason | null;
      }
    | ProbeFailure;
}

/** Reads the removal sends, made against the finished launch before cleanup. */
export interface RemovalReadsBeforeCleanup {
  listAppTigris: Probe<ListAppTigrisObservation>;
  /** `DorkosAppNameAvailable` for the gate's own app while it exists; expected `false`. */
  appNameWhileLive: Probe<{ available: boolean }>;
}

/** Boundaries for {@link readRemovalBeforeCleanup}, bound to the removal's own code by the caller. */
export interface RemovalReadsBeforeDependencies {
  /** The removal's Tigris probe `find` (`DorkosListAppTigris` through its parser and mapping). */
  findTigris(intent: PendingIntent): Promise<ProbeResult>;
  /** `DorkosAppNameAvailable` through the launcher's client. */
  isAppNameAvailable(appName: string): Promise<boolean>;
}

function journalFailure(code: string): ProbeFailure {
  return { ok: false, code: `journal:${code}` };
}

function liveError(code: string): Error {
  const error = new Error(`Community live removal read failed (${code})`);
  error.name = 'CommunityLiveProbeError';
  return Object.assign(error, { code });
}

/**
 * Run the removal's reads against the finished launch, before cleanup. Never throws.
 *
 * @param rawJournal - The finished run's journal as read from disk.
 * @param observed - The create timings the gate watched, for the bucket's `requestedAt`.
 * @param dependencies - The removal's own read boundaries.
 */
export async function readRemovalBeforeCleanup(
  rawJournal: unknown,
  observed: ObservedCreates,
  dependencies: RemovalReadsBeforeDependencies
): Promise<RemovalReadsBeforeCleanup> {
  const names = readRemovalJournalNames(rawJournal);
  const { appName, bucketName, flyOrganization, tigrisBucketId } = names;
  const listAppTigris: RemovalReadsBeforeCleanup['listAppTigris'] =
    !appName || !bucketName || !flyOrganization || !tigrisBucketId
      ? journalFailure('JOURNAL_TIGRIS_IDENTITY')
      : await probe(async () => {
          // The same intent a run stopped mid-create would carry, timed as this run's was.
          const intent: PendingIntent = {
            provider: 'tigris',
            organizationId: flyOrganization,
            resourceName: bucketName,
            ...(observed.tigris.requestedAt === null
              ? {}
              : { requestedAt: observed.tigris.requestedAt }),
          };
          const found = await dependencies.findTigris(intent);
          if (found.kind !== 'tigris') throw liveError('UNEXPECTED_PROBE_RESULT');
          const facts = found.facts;
          // By exact id: the name alone is what the removal must prove, not what it may assume.
          const bucket = facts?.addOns.find((addOn) => addOn.token === tigrisBucketId) ?? null;
          const parsed = LaunchJournalSchema.safeParse(rawJournal);
          let verdict: ListAppTigrisObservation['verdict'];
          if (parsed.success) {
            const decided = evaluateUncertainResource(parsed.data, intent, found);
            verdict = {
              ok: true,
              result: decided.verdict,
              unprovedReason: decided.verdict === 'unproved' ? decided.reason : null,
            };
          } else {
            verdict = journalFailure('SCHEMA_MISMATCH');
          }
          return {
            appFound: facts !== null,
            appNameMatchesJournal: facts !== null && facts.app.name === appName,
            network: identifier(facts?.app.network) ?? null,
            networkMatchesJournal:
              facts !== null &&
              facts.app.network !== null &&
              facts.app.network === names.flyNetwork,
            organizationMatchesJournal:
              facts !== null && facts.app.organization === flyOrganization,
            totalCount: facts?.totalCount ?? null,
            listedCount: facts?.addOns.length ?? null,
            complete: facts !== null && facts.totalCount === facts.addOns.length,
            journaledBucket:
              bucket === null
                ? null
                : {
                    nameMatchesJournal: bucket.name === bucketName,
                    organizationMatchesJournal: bucket.organization === flyOrganization,
                    createdAt: bucket.createdAt,
                  },
            verdict,
          };
        });
  const appNameWhileLive = appName
    ? await probe(async () => ({ available: await dependencies.isAppNameAvailable(appName) }))
    : journalFailure('JOURNAL_APP_NAME');
  return { listAppTigris, appNameWhileLive };
}

/** A before-cleanup record in which both reads failed with one code. */
export function failedRemovalReadsBeforeCleanup(code: string): RemovalReadsBeforeCleanup {
  const failed: ProbeFailure = { ok: false, code };
  return { listAppTigris: failed, appNameWhileLive: failed };
}

/**
 * Run {@link readRemovalBeforeCleanup} so cleanup never waits on it past its deadline.
 *
 * @param run - The reads.
 * @param deadlineMs - Overall deadline.
 */
export function guardRemovalReadsBeforeCleanup(
  run: () => Promise<RemovalReadsBeforeCleanup>,
  deadlineMs: number = REMOVAL_READS_DEADLINE_MS
): Promise<RemovalReadsBeforeCleanup> {
  return guardProbeRun(run, failedRemovalReadsBeforeCleanup, deadlineMs);
}

/** One name read after cleanup: whether Fly still holds the name, or why it could not be read. */
export type NameRead = { ok: true; held: boolean } | ProbeFailure;

/** How one name behaved after cleanup, over repeated reads. */
export interface NameAfterCleanup {
  reads: number;
  first: NameRead;
  last: NameRead;
  /** Time from the start of the wait to the first read that showed the name free; else `null`. */
  releasedAfterMs: number | null;
  /**
   * Why reading stopped: the name was free, the wait ran out, three reads in a row failed, or the
   * operator interrupted the wait.
   */
  endedBy: 'released' | 'deadline' | 'failures' | 'interrupt';
}

/** The two name reads the removal relies on, made after cleanup finished. */
export interface RemovalReadsAfterCleanup {
  /** `DorkosAppNameAvailable`; `held` is `!appNameAvailable`. Expected to be free. */
  appName: NameAfterCleanup | ProbeFailure;
  /** `DorkosFindTigrisByName`; free only on Fly's exact `NOT_FOUND`. Expected to be free. */
  tigrisName: NameAfterCleanup | ProbeFailure;
}

/** Boundaries for {@link readRemovalNamesAfterCleanup}. Each read must stop when its signal aborts. */
export interface RemovalReadsAfterDependencies {
  isAppNameAvailable(appName: string, signal: AbortSignal): Promise<boolean>;
  isTigrisNameHeld(bucketName: string, signal: AbortSignal): Promise<boolean>;
  now(): number;
  /** Wait, resolving early when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/**
 * Wait, resolving early when the signal aborts. The timer never keeps the process alive.
 *
 * @param ms - How long to wait.
 * @param signal - Ends the wait early.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener('abort', done, { once: true });
  });
}

interface NameTrack {
  name: string;
  read(name: string, signal: AbortSignal): Promise<boolean>;
  /** The read answers "available"; `held` is its opposite. */
  invert: boolean;
  record: NameAfterCleanup | null;
  failuresInRow: number;
  done: boolean;
}

/**
 * Read both names after cleanup, again and again until both are free, the deadline passes, a name
 * fails three reads in a row, or the signal aborts, so the receipt shows how long Fly holds each.
 * Each read is cancelled when the time left runs out. Never throws, and returns only once no read
 * is still running.
 *
 * @param names - The gate's app and bucket names, from its journal.
 * @param dependencies - Read boundaries and clock.
 * @param options - Pause between rounds, overall deadline and cancellation.
 */
export async function readRemovalNamesAfterCleanup(
  names: { appName?: string | undefined; bucketName?: string | undefined },
  dependencies: RemovalReadsAfterDependencies,
  options: { intervalMs?: number; deadlineMs?: number; signal?: AbortSignal } = {}
): Promise<RemovalReadsAfterCleanup> {
  const intervalMs = options.intervalMs ?? NAME_RELEASE_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? NAME_RELEASE_DEADLINE_MS;
  const signal = options.signal ?? new AbortController().signal;
  const track = (
    name: string | undefined,
    read: NameTrack['read'],
    invert: boolean
  ): NameTrack | null =>
    name ? { name, read, invert, record: null, failuresInRow: 0, done: false } : null;
  const tracks = [
    track(names.appName, (name, s) => dependencies.isAppNameAvailable(name, s), true),
    track(names.bucketName, (name, s) => dependencies.isTigrisNameHeld(name, s), false),
  ];
  const start = dependencies.now();
  const endAt = start + deadlineMs;
  const active = () => tracks.filter((item): item is NameTrack => item !== null && !item.done);
  rounds: for (;;) {
    for (const item of active()) {
      const left = endAt - dependencies.now();
      if (signal.aborted || left <= 0) break rounds;
      let answer: NameRead;
      try {
        const held = await item.read(
          item.name,
          AbortSignal.any([signal, AbortSignal.timeout(left)])
        );
        answer = { ok: true, held: item.invert ? !held : held };
      } catch (error) {
        // A read the operator cut off says nothing about the name; it is not recorded.
        if (signal.aborted) break rounds;
        answer = { ok: false, code: failureCode(error) };
      }
      const elapsed = dependencies.now() - start;
      item.record = item.record
        ? { ...item.record, reads: item.record.reads + 1, last: answer }
        : { reads: 1, first: answer, last: answer, releasedAfterMs: null, endedBy: 'deadline' };
      if (answer.ok && !answer.held) {
        item.done = true;
        item.record.releasedAfterMs = elapsed;
        item.record.endedBy = 'released';
      } else if (!answer.ok && ++item.failuresInRow >= NAME_READ_FAILURE_LIMIT) {
        item.done = true;
        item.record.endedBy = 'failures';
      } else if (answer.ok) {
        item.failuresInRow = 0;
      }
    }
    if (active().length === 0 || signal.aborted) break;
    const left = endAt - dependencies.now();
    if (left <= 0) break;
    await dependencies.sleep(Math.min(intervalMs, left), signal);
  }
  const ending = signal.aborted ? 'interrupt' : 'deadline';
  const outcome = (item: NameTrack | null, missing: string): NameAfterCleanup | ProbeFailure => {
    if (item === null) return journalFailure(missing);
    if (item.record === null) {
      return { ok: false, code: signal.aborted ? 'guard:INTERRUPTED' : 'guard:PROBE_DEADLINE' };
    }
    return item.done ? item.record : { ...item.record, endedBy: ending };
  };
  return {
    appName: outcome(tracks[0]!, 'JOURNAL_APP_NAME'),
    tigrisName: outcome(tracks[1]!, 'JOURNAL_BUCKET_NAME'),
  };
}

/** An after-cleanup record in which both reads failed with one code. */
export function failedRemovalReadsAfterCleanup(code: string): RemovalReadsAfterCleanup {
  const failed: ProbeFailure = { ok: false, code };
  return { appName: failed, tigrisName: failed };
}

/**
 * Run {@link readRemovalNamesAfterCleanup} under a backstop deadline. When the deadline passes,
 * or `options.signal` aborts, the reads are cancelled through the signal handed to `run`; a run
 * that has not stopped a few seconds after its deadline is replaced by `guard:PROBE_DEADLINE`.
 *
 * @param run - The reads, which must stop when their signal aborts.
 * @param options - Backstop deadline and outside cancellation (the operator's Control-C).
 */
export async function guardRemovalReadsAfterCleanup(
  run: (signal: AbortSignal) => Promise<RemovalReadsAfterCleanup>,
  options: { deadlineMs?: number; signal?: AbortSignal } = {}
): Promise<RemovalReadsAfterCleanup> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    return await guardProbeRun(
      () => {
        const timer = setTimeout(cancel, options.deadlineMs ?? NAME_RELEASE_GUARD_MS);
        timer.unref();
        return run(controller.signal).finally(() => clearTimeout(timer));
      },
      failedRemovalReadsAfterCleanup,
      (options.deadlineMs ?? NAME_RELEASE_GUARD_MS) + CANCEL_GRACE_MS
    );
  } finally {
    cancel();
    options.signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Run `work` with Control-C, SIGTERM and SIGHUP turned into a cancellation of it instead of the
 * end of the process, so a wait the operator cuts short still finishes the run. Every further
 * signal while `work` runs is absorbed; the handlers are removed when it settles.
 *
 * @param signals - The process, or a fake in tests.
 * @param work - The interruptible work.
 */
export async function whileInterruptible<T>(
  signals: SignalSource,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  for (const event of STOP_SIGNALS) signals.on(event, onSignal);
  try {
    return await work(controller.signal);
  } finally {
    for (const event of STOP_SIGNALS) signals.off(event, onSignal);
  }
}

/** The receipt's `provenance.removal` block (provenance schema 3). */
export interface CommunityLiveRemovalReceipt {
  beforeCleanup: RemovalReadsBeforeCleanup;
  afterCleanup: RemovalReadsAfterCleanup;
  createWindows: Record<RemovalProvider, CreateWindowObservation>;
  journalWatch: { polls: number; unreadablePolls: number };
}

/**
 * Assemble the removal block, taking each service's creation time from the read that saw it: the
 * Fly app and Neon project from the marker probes, the bucket from `DorkosListAppTigris`.
 *
 * @param input - Everything the gate recorded.
 */
export function buildCommunityLiveRemovalReceipt(input: {
  observed: ObservedCreates;
  before: RemovalReadsBeforeCleanup;
  after: RemovalReadsAfterCleanup;
  flyCreatedAt: string | null;
  neonCreatedAt: string | null;
}): CommunityLiveRemovalReceipt {
  const tigrisCreatedAt = input.before.listAppTigris.ok
    ? (input.before.listAppTigris.journaledBucket?.createdAt ?? null)
    : null;
  return {
    beforeCleanup: input.before,
    afterCleanup: input.after,
    createWindows: describeCreateWindows(input.observed, {
      fly: input.flyCreatedAt,
      neon: input.neonCreatedAt,
      tigris: tigrisCreatedAt,
    }),
    journalWatch: { polls: input.observed.polls, unreadablePolls: input.observed.unreadablePolls },
  };
}
