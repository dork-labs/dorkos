/**
 * The uncertain-create removal's own reads, run read-only against the live gate's real launch
 * (DOR-2606), and the real timing of each create.
 *
 * The provenance probes prove the markers come back unchanged. They do not send what
 * `--remove-uncertain` itself sends to find a Tigris bucket (`DorkosListAppTigris` with the app's
 * network and organization and each bucket's `createdAt` and organization), nor the two name reads
 * it relies on (`DorkosAppNameAvailable`, `DorkosFindTigrisByName`), and nothing has measured how
 * far a service's `createdAt` sits from the journal's `requestedAt`. This module records all of
 * that as non-secret fields for the receipt's `provenance.removal` block.
 *
 * Nothing here writes to a service. Every read catches its own failure and records a stable code
 * in its place, never provider text, so no read can fail the gate or hold up its cleanup.
 */
import {
  LaunchJournalSchema,
  type LaunchJournal,
} from '../src/commands/community-deploy/journal.js';
import {
  CREATE_WINDOW_MARGIN_MS,
  isCreatedWithinWindow,
} from '../src/commands/community-deploy/provenance/provenance-gate.js';
import {
  createDeadlineFor,
  evaluateUncertainResource,
  type PendingIntent,
  type ProbeResult,
  type RemovalProvider,
  type UnprovedReason,
} from '../src/commands/community-deploy/provenance/uncertain-verdict.js';
import {
  failureCode,
  guardProbeRun,
  probe,
  type Probe,
  type ProbeFailure,
} from './community-deploy-live-provenance.js';

const PROVIDERS = ['fly', 'neon', 'tigris'] as const satisfies readonly RemovalProvider[];
const RESOURCE_KEY = {
  fly: 'flyAppId',
  neon: 'neonProjectId',
  tigris: 'tigrisBucketId',
} as const satisfies Record<RemovalProvider, string>;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:+=/-]{0,255}$/u;

/** How often the gate reads the launch journal while the launcher runs. */
export const CREATE_WATCH_INTERVAL_MS = 200;
/** How often the after-cleanup name reads are repeated until both names are free. */
export const NAME_RELEASE_INTERVAL_MS = 15_000;
/** How long the after-cleanup name reads wait for both names to be free. */
export const NAME_RELEASE_DEADLINE_MS = 3 * 60_000;
/** Longest the before-cleanup reads may take before cleanup goes ahead without them. */
export const REMOVAL_READS_DEADLINE_MS = 2 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeTime(value: unknown): string | null {
  return typeof value === 'string' && SAFE_VALUE.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function safeValue(value: unknown): string | null {
  return typeof value === 'string' && SAFE_VALUE.test(value) ? value : null;
}

/** What the gate saw of one create while the launcher ran. */
export interface ObservedCreate {
  /**
   * The `requestedAt` the journal recorded with this create's intent, or `null` when no poll saw
   * the intent (the create finished between two polls).
   */
  requestedAt: string | null;
  /**
   * The journal's `updatedAt` on the first revision seen with the created id recorded: when the
   * create returned, or its readback finished if a poll missed that revision. `null` if never seen.
   */
  idRecordedAt: string | null;
}

/** Every create the gate watched, and how its journal reads went. */
export interface ObservedCreates {
  fly: ObservedCreate;
  neon: ObservedCreate;
  tigris: ObservedCreate;
  /** Journal reads made, including ones before the launcher had written a journal. */
  polls: number;
  /** Reads of a journal that existed but could not be read or parsed. */
  unreadablePolls: number;
}

/**
 * Collect create timings from successive journal revisions. Keeps the first value seen for each,
 * since a later revision can only be further from the moment it describes.
 */
export function createIntentObserver(): {
  observe(journal: unknown): void;
  unreadable(): void;
  result(): ObservedCreates;
} {
  const seen: Record<RemovalProvider, ObservedCreate> = {
    fly: { requestedAt: null, idRecordedAt: null },
    neon: { requestedAt: null, idRecordedAt: null },
    tigris: { requestedAt: null, idRecordedAt: null },
  };
  let polls = 0;
  let unreadablePolls = 0;
  return {
    observe(journal) {
      polls += 1;
      if (!isRecord(journal)) {
        unreadablePolls += 1;
        return;
      }
      const intent = journal.pendingIntent;
      if (isRecord(intent)) {
        const provider = intent.provider;
        const requestedAt = safeTime(intent.requestedAt);
        if (
          (provider === 'fly' || provider === 'neon' || provider === 'tigris') &&
          requestedAt !== null &&
          seen[provider].requestedAt === null
        ) {
          seen[provider].requestedAt = requestedAt;
        }
      }
      const resources = isRecord(journal.resources) ? journal.resources : {};
      const updatedAt = safeTime(journal.updatedAt);
      for (const provider of PROVIDERS) {
        if (
          typeof resources[RESOURCE_KEY[provider]] === 'string' &&
          updatedAt !== null &&
          seen[provider].idRecordedAt === null
        ) {
          seen[provider].idRecordedAt = updatedAt;
        }
      }
    },
    unreadable() {
      polls += 1;
      unreadablePolls += 1;
    },
    result() {
      return {
        fly: { ...seen.fly },
        neon: { ...seen.neon },
        tigris: { ...seen.tigris },
        polls,
        unreadablePolls,
      };
    },
  };
}

/**
 * Read the launch journal on an interval until stopped. The journal is written by rename, so each
 * read sees one whole revision.
 *
 * @param read - Reads the run's journal; `null` while there is none yet. A throw counts as unreadable.
 * @param intervalMs - Pause between reads.
 * @returns `stop`, which makes one last read and resolves the observations; safe to call twice.
 */
export function watchCommunityLiveCreates(
  read: () => Promise<unknown>,
  intervalMs: number = CREATE_WATCH_INTERVAL_MS
): { stop(): Promise<ObservedCreates> } {
  const observer = createIntentObserver();
  let stopped = false;
  let wake: (() => void) | null = null;
  const readOnce = async () => {
    try {
      const journal = await read();
      if (journal === null) observer.observe({});
      else observer.observe(journal);
    } catch {
      observer.unreadable();
    }
  };
  const loop = (async () => {
    while (!stopped) {
      await readOnce();
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  })();
  let finished: Promise<ObservedCreates> | null = null;
  return {
    stop() {
      finished ??= (async () => {
        stopped = true;
        (wake as (() => void) | null)?.();
        await loop;
        await readOnce();
        return observer.result();
      })();
      return finished;
    },
  };
}

/** What `DorkosListAppTigris`, read through the removal's own probe, showed about the live run. */
export interface ListAppTigrisObservation {
  appFound: boolean;
  appNameMatchesJournal: boolean;
  network: string | null;
  networkMatchesJournal: boolean;
  organizationSlug: string | null;
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
   * bucket. A healthy run is `proved`; anything else is the reason the removal would stop.
   */
  verdict: 'proved' | 'absent' | 'unproved' | 'unreachable';
  unprovedReason: UnprovedReason | null;
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
  findTigris(intent: PendingIntent, journal: LaunchJournal): Promise<ProbeResult>;
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
  const parsed = LaunchJournalSchema.safeParse(rawJournal);
  const journal = parsed.success ? parsed.data : null;
  const context = journal?.recoveryContext;
  const listAppTigris: RemovalReadsBeforeCleanup['listAppTigris'] =
    journal === null
      ? journalFailure('INVALID_JOURNAL')
      : !context || !journal.resources.tigrisBucketId
        ? journalFailure('JOURNAL_TIGRIS_IDENTITY')
        : await probe(async () => {
            // The same intent a run stopped mid-create would carry, timed as this run's was.
            const intent: PendingIntent = {
              provider: 'tigris',
              organizationId: context.flyOrganization,
              resourceName: context.bucketName,
              ...(observed.tigris.requestedAt === null
                ? {}
                : { requestedAt: observed.tigris.requestedAt }),
            };
            const found = await dependencies.findTigris(intent, journal);
            if (found.kind !== 'tigris') throw liveError('UNEXPECTED_PROBE_RESULT');
            const facts = found.facts;
            const bucket =
              facts?.addOns.find((addOn) => addOn.token === journal.resources.tigrisBucketId) ??
              null;
            const decided = evaluateUncertainResource(journal, intent, found);
            return {
              appFound: facts !== null,
              appNameMatchesJournal: facts?.app.name === context.appName,
              network: safeValue(facts?.app.network),
              networkMatchesJournal:
                facts !== null &&
                facts.app.network !== null &&
                facts.app.network === journal.provenance?.flyNetwork,
              organizationSlug: safeValue(facts?.app.organization),
              organizationMatchesJournal: facts?.app.organization === context.flyOrganization,
              totalCount: facts?.totalCount ?? null,
              listedCount: facts?.addOns.length ?? null,
              complete: facts !== null && facts.totalCount === facts.addOns.length,
              journaledBucket:
                bucket === null
                  ? null
                  : {
                      nameMatchesJournal: bucket.name === context.bucketName,
                      organizationMatchesJournal: bucket.organization === context.flyOrganization,
                      createdAt: bucket.createdAt,
                    },
              verdict: decided.verdict,
              unprovedReason: decided.verdict === 'unproved' ? decided.reason : null,
            };
          });
  const appName = context?.appName;
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

/** One create's request time against the service's creation time. */
export interface CreateWindowObservation {
  requestedAt: string | null;
  idRecordedAt: string | null;
  /** Creation time the service reported, or `null` when it could not be read. */
  createdAt: string | null;
  /** `createdAt - requestedAt`; negative means the service's clock is behind this machine's. */
  createdMinusRequestedMs: number | null;
  /** `idRecordedAt - requestedAt`: how long the create took, as the launcher saw it. */
  idRecordedMinusRequestedMs: number | null;
  /** The create deadline the removal's window uses for this service. */
  windowDeadlineMs: number;
  /** The margin the window allows either side, for clock skew. */
  windowMarginMs: number;
  /** Whether the removal's own window check accepts this create. */
  withinWindow: boolean;
}

function differenceMs(later: string | null, earlier: string | null): number | null {
  if (later === null || earlier === null) return null;
  return Date.parse(later) - Date.parse(earlier);
}

/**
 * Put each create's watched request time beside the service's creation time, through the removal's
 * own window check.
 *
 * @param observed - The watched create timings.
 * @param createdAt - Creation time each service reported, or `null` where it could not be read.
 */
export function describeCreateWindows(
  observed: ObservedCreates,
  createdAt: Record<RemovalProvider, string | null>
): Record<RemovalProvider, CreateWindowObservation> {
  const describe = (provider: RemovalProvider): CreateWindowObservation => {
    const { requestedAt, idRecordedAt } = observed[provider];
    const created = safeTime(createdAt[provider]);
    const windowDeadlineMs = createDeadlineFor(provider);
    return {
      requestedAt,
      idRecordedAt,
      createdAt: created,
      createdMinusRequestedMs: differenceMs(created, requestedAt),
      idRecordedMinusRequestedMs: differenceMs(idRecordedAt, requestedAt),
      windowDeadlineMs,
      windowMarginMs: CREATE_WINDOW_MARGIN_MS,
      withinWindow: isCreatedWithinWindow(
        created ?? undefined,
        requestedAt ?? undefined,
        windowDeadlineMs
      ),
    };
  };
  return { fly: describe('fly'), neon: describe('neon'), tigris: describe('tigris') };
}

/** One name read after cleanup: whether Fly still holds the name, or why it could not be read. */
export type NameRead = { ok: true; held: boolean } | ProbeFailure;

/** How one name behaved after cleanup, over repeated reads. */
export interface NameAfterCleanup {
  reads: number;
  first: NameRead;
  last: NameRead;
  /** Time from the first read to the first one that showed the name free; `null` if never. */
  releasedAfterMs: number | null;
}

/** The two name reads the removal relies on, made after cleanup finished. */
export interface RemovalReadsAfterCleanup {
  /** `DorkosAppNameAvailable`; `held` is `!appNameAvailable`. Expected to be free. */
  appName: NameAfterCleanup | ProbeFailure;
  /** `DorkosFindTigrisByName`; free only on Fly's exact `NOT_FOUND`. Expected to be free. */
  tigrisName: NameAfterCleanup | ProbeFailure;
}

/** Boundaries for {@link readRemovalNamesAfterCleanup}. */
export interface RemovalReadsAfterDependencies {
  isAppNameAvailable(appName: string): Promise<boolean>;
  isTigrisNameHeld(bucketName: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

async function readName(read: () => Promise<boolean>): Promise<NameRead> {
  try {
    return { ok: true, held: await read() };
  } catch (error) {
    return { ok: false, code: failureCode(error) };
  }
}

/**
 * Read both names after cleanup, again and again until both are free or the deadline passes, so
 * the receipt shows how long Fly holds each. Never throws: a failed read is recorded and read again.
 *
 * @param names - The gate's app and bucket names, from its journal.
 * @param dependencies - Read boundaries and clock.
 * @param options - Pause between rounds and overall deadline.
 */
export async function readRemovalNamesAfterCleanup(
  names: { appName: string | undefined; bucketName: string | undefined },
  dependencies: RemovalReadsAfterDependencies,
  options: { intervalMs?: number; deadlineMs?: number } = {}
): Promise<RemovalReadsAfterCleanup> {
  const intervalMs = options.intervalMs ?? NAME_RELEASE_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? NAME_RELEASE_DEADLINE_MS;
  const { appName, bucketName } = names;
  const tracks = [
    appName
      ? {
          name: appName,
          read: (name: string) => dependencies.isAppNameAvailable(name),
          invert: true,
        }
      : null,
    bucketName
      ? {
          name: bucketName,
          read: (name: string) => dependencies.isTigrisNameHeld(name),
          invert: false,
        }
      : null,
  ].map((track) =>
    track === null
      ? null
      : { ...track, record: null as NameAfterCleanup | null, released: false as boolean }
  );
  const start = dependencies.now();
  for (;;) {
    for (const track of tracks) {
      if (track === null || track.released) continue;
      const answer = await readName(async () => {
        const value = await track.read(track.name);
        return track.invert ? !value : value;
      });
      const elapsed = dependencies.now() - start;
      const released = answer.ok && !answer.held;
      track.record = track.record
        ? { ...track.record, reads: track.record.reads + 1, last: answer }
        : { reads: 1, first: answer, last: answer, releasedAfterMs: null };
      if (released) {
        track.released = true;
        track.record.releasedAfterMs = elapsed;
      }
    }
    const waiting = tracks.some((track) => track !== null && !track.released);
    if (!waiting || dependencies.now() - start >= deadlineMs) break;
    await dependencies.sleep(intervalMs);
  }
  const [app, bucket] = tracks;
  return {
    appName: app?.record ?? journalFailure('JOURNAL_APP_NAME'),
    tigrisName: bucket?.record ?? journalFailure('JOURNAL_BUCKET_NAME'),
  };
}

/** An after-cleanup record in which both reads failed with one code. */
export function failedRemovalReadsAfterCleanup(code: string): RemovalReadsAfterCleanup {
  const failed: ProbeFailure = { ok: false, code };
  return { appName: failed, tigrisName: failed };
}

/**
 * Run {@link readRemovalNamesAfterCleanup} under a deadline that covers its own polling plus a few
 * slow reads, so a hung read can never stop the receipt from being written.
 *
 * @param run - The reads.
 * @param deadlineMs - Overall deadline.
 */
export function guardRemovalReadsAfterCleanup(
  run: () => Promise<RemovalReadsAfterCleanup>,
  deadlineMs: number = NAME_RELEASE_DEADLINE_MS + 2 * 60_000
): Promise<RemovalReadsAfterCleanup> {
  return guardProbeRun(run, failedRemovalReadsAfterCleanup, deadlineMs);
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
