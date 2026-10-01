/**
 * The real timing of each create in a live-gate launch (DOR-2606).
 *
 * The uncertain-create removal accepts a found resource only when the service's `createdAt` falls
 * inside a window around the journal's `requestedAt`. The launcher clears `requestedAt` as soon as
 * a create completes, so the finished journal no longer has it: the gate reads the journal while
 * the launcher runs, then puts each request time beside the service's creation time through the
 * removal's own window check. Only local files are read here; nothing contacts a service.
 */
import {
  CREATE_WINDOW_MARGIN_MS,
  isCreatedWithinWindow,
} from '../src/commands/community-deploy/provenance/provenance-gate.js';
import {
  createDeadlineFor,
  type RemovalProvider,
} from '../src/commands/community-deploy/provenance/uncertain-verdict.js';

const PROVIDERS = ['fly', 'neon', 'tigris'] as const satisfies readonly RemovalProvider[];
const RESOURCE_KEY = {
  fly: 'flyAppId',
  neon: 'neonProjectId',
  tigris: 'tigrisBucketId',
} as const satisfies Record<RemovalProvider, string>;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:+=/-]{0,255}$/u;

/** How often the gate reads the launch journal while the launcher runs. */
export const CREATE_WATCH_INTERVAL_MS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A short, parseable timestamp, or `null`.
 *
 * @param value - Anything read from a journal or a service.
 */
export function safeTime(value: unknown): string | null {
  return typeof value === 'string' && SAFE_VALUE.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** What the gate saw of one create while the launcher ran. */
export interface ObservedCreate {
  /**
   * The `requestedAt` the journal recorded with this create's intent, or `null` when no read saw
   * the intent (the create finished between two reads).
   */
  requestedAt: string | null;
  /**
   * The journal's `updatedAt` on the first revision seen with the created id recorded: when the
   * create returned, or its readback finished if a read missed that revision. `null` if never seen.
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
 * since a later revision can only be further from the moment it describes, and a resumed create
 * writes a new intent with a later request time.
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
 * read sees one whole revision. The timer never keeps the process alive on its own.
 *
 * @param read - Reads the run's journal; `null` while there is none yet. A throw counts as unreadable.
 * @param intervalMs - Pause between reads.
 * @returns `stop`, which wakes the watch at once, makes one last read and resolves the
 *   observations; safe to call twice.
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
      observer.observe(journal === null ? {} : journal);
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
        timer.unref();
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
