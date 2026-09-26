/**
 * Per-account Claude usage: the on-disk usage ledger shared with flow, and the
 * wire shape every surface serves for one account.
 *
 * The ledger contract (`<dorkHome>/usage/<account-id>.json`) is public and
 * tracker-neutral: flow and DorkOS each implement it independently and prove
 * it against one fixture set (marketplace `specs/flow-cli-core` §1.2). The
 * names below are spelled exactly as that contract spells them. Everything in
 * this module is pure: no filesystem, no clock, no logging. Callers pass `now`
 * and log whatever a function reports as dropped.
 *
 * @module shared/account-usage
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

// === Account identity and color ===

/**
 * The pattern every account registry id must match (contract §1.1a). It is
 * also the ledger's file name, so anything else is refused: no path traversal.
 */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A stored account color: lowercase `#rrggbb` (contract §1.1a). */
const ACCOUNT_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/**
 * The positional default colors for accounts with no stored color.
 *
 * Provisional: the UI track owns these values, and nothing persists them (a
 * stored `color: null` means "the default for this position", resolved at read
 * time), so they may change freely.
 */
export const DEFAULT_ACCOUNT_COLORS: readonly string[] = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
];

/** Wrap any integer position into the default palette, negatives included. */
function paletteColorAt(index: number): string {
  const n = DEFAULT_ACCOUNT_COLORS.length;
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return DEFAULT_ACCOUNT_COLORS[((i % n) + n) % n]!;
}

/**
 * The color an account is drawn in: its stored color when that is a valid
 * lowercase `#rrggbb`, else the default for its position in the registry.
 *
 * @param stored - The row's stored `color`, possibly `null` or a hand-edited bad value.
 * @param index - The row's position in the registry; wraps around the palette.
 */
export function resolveAccountColor(stored: string | null | undefined, index: number): string {
  if (typeof stored === 'string' && ACCOUNT_COLOR_PATTERN.test(stored)) return stored;
  return paletteColorAt(index);
}

/**
 * The color to give a newly registered account: the first palette value no
 * existing row uses, else the positional default when every value is taken.
 *
 * @param taken - The colors registered rows already resolve to.
 * @param index - The new row's position in the registry.
 */
export function nextAccountColor(taken: Iterable<string>, index: number): string {
  const used = new Set<string>();
  for (const color of taken) used.add(color.toLowerCase());
  return DEFAULT_ACCOUNT_COLORS.find((color) => !used.has(color)) ?? paletteColorAt(index);
}

/**
 * The id of the Flow extension's fleet settings tab, so core surfaces can link
 * straight to where routing policy is edited.
 */
export const FLOW_FLEET_SETTINGS_TAB_ID = 'flow:fleet';

// === The usage ledger (contract §1.2) ===

/** Where a ledger reading came from. Writers convert each into one unit. */
export const LEDGER_SOURCES = ['statusline', 'sdk_event', 'sdk_usage', 'transcript'] as const;

/** Inferred type for one member of {@link LEDGER_SOURCES}. */
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

/** The rate-limit status a source reported for a window. */
export const RateLimitStatusSchema = z
  .enum(['allowed', 'allowed_warning', 'rejected'])
  .openapi('RateLimitStatus');

/** Inferred type for {@link RateLimitStatusSchema}. */
export type RateLimitStatus = z.infer<typeof RateLimitStatusSchema>;

/**
 * One window's reading. `observedAt` is when the SOURCE saw it, not when it was
 * written. At least one of `usedPct` and `status` must be non-null.
 */
export const LedgerEntrySchema = z
  .object({
    /** Share of the window used, 0 to 100, or `null` when the source gave none. */
    usedPct: z.number().min(0).max(100).nullable(),
    /** When the window resets, ISO-8601, or `null` when unknown. */
    resetsAt: z.string().datetime({ offset: true }).nullable(),
    /** The status the source reported, or `null` when it reported none. */
    status: RateLimitStatusSchema.nullable(),
    /** When the source observed this reading, ISO-8601 with an explicit zone. */
    observedAt: z.string().datetime({ offset: true }),
    /** Which source produced the reading. */
    source: z.enum(LEDGER_SOURCES),
  })
  .refine((e) => e.usedPct !== null || e.status !== null, {
    message: 'At least one of usedPct and status must be non-null',
  });

/** Inferred type for {@link LedgerEntrySchema}. */
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * A ledger window key: a known window (`five_hour`, `seven_day`, …), any
 * future snake_case window, or a per-model bucket `model:<slug>`.
 */
export const WINDOW_KEY_PATTERN = /^(model:[a-z0-9][a-z0-9._-]*|[a-z][a-z0-9_]*)$/;

/**
 * One account's usage ledger file. Loose, so fields a newer writer adds
 * survive a read-modify-write by an older one.
 */
export const UsageLedgerSchema = z.looseObject({
  /** Contract version. */
  v: z.literal(1),
  /** The registry id this ledger belongs to. */
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  /** The last write, any window. */
  updatedAt: z.string().datetime({ offset: true }),
  /** Readings by window key. */
  windows: z.record(z.string().regex(WINDOW_KEY_PATTERN), LedgerEntrySchema),
});

/** Inferred type for {@link UsageLedgerSchema}. */
export type UsageLedger = z.infer<typeof UsageLedgerSchema>;

/** One reading to merge into a ledger, tagged with its window key. */
export type LedgerObservation = { key: string } & LedgerEntry;

/** A ledger entry as read at a moment: expired windows read as reset. */
export type ReadWindow = LedgerEntry & {
  /** True when the window's `resetsAt` has passed, so the reading was reset to 0. */
  expired: boolean;
};

const HOUR_MS = 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const SEVEN_DAY_MS = 7 * 24 * HOUR_MS;
/** How far past `now` an observation's clock may run before it is dropped. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** The span after which a reading with no `resetsAt` is stale. */
function windowLengthMs(key: string): number {
  return key === 'five_hour' ? FIVE_HOUR_MS : SEVEN_DAY_MS;
}

/**
 * Read one window at `now` (contract "Reading a window").
 *
 * - Expired (`resetsAt` set and `now ≥ resetsAt`): reads as `usedPct 0`,
 *   `status 'allowed'`, `expired: true`.
 * - Stale (`resetsAt` null and older than the window length: `five_hour` 5 h,
 *   every other key 7 days): reads as no reading, `null`.
 * - Otherwise: as stored.
 *
 * @param key - The window key, which decides the stale length.
 * @param entry - The stored reading.
 * @param now - The moment to read at.
 */
export function readWindow(key: string, entry: LedgerEntry, now: Date): ReadWindow | null {
  const nowMs = now.getTime();
  if (entry.resetsAt !== null) {
    if (nowMs >= Date.parse(entry.resetsAt)) {
      return { ...entry, usedPct: 0, status: 'allowed', expired: true };
    }
    return { ...entry, expired: false };
  }
  if (nowMs - Date.parse(entry.observedAt) > windowLengthMs(key)) return null;
  return { ...entry, expired: false };
}

/** Why {@link mergeLedger} set one observation aside. */
export interface DroppedObservation {
  /** The observation's window key, as given. */
  key: string;
  /** A short reason, for the caller's warning log. */
  reason: string;
}

/** The outcome of {@link mergeLedger}. */
export interface MergeLedgerResult {
  /** The merged ledger. Equal to the input (same `updatedAt`) when nothing changed. */
  ledger: UsageLedger;
  /** Whether anything changed. A writer that sees `false` does not rewrite the file. */
  changed: boolean;
  /** Observations set aside, with why. The rest still merged. */
  dropped: DroppedObservation[];
}

/**
 * Merge observations into a ledger (contract "Merging").
 *
 * Per window key, an observation replaces the stored entry only when its
 * `observedAt` is strictly later; an equal one keeps the stored entry, so a
 * replay is a no-op. A newer observation always wins, even with a lower
 * `usedPct` (the window reset). An observation more than 5 minutes after `now`
 * is dropped, so one bad clock cannot pin a window. An invalid one is dropped
 * while the rest merge. `usedPct` is clamped to 0 to 100 before validation.
 * `updatedAt` becomes `now` only when something changed. Unknown window keys
 * and unknown top-level fields are kept.
 *
 * Pure: it never logs. Callers log `dropped`.
 *
 * @param existing - The stored ledger, or `null` when there is none yet.
 * @param observations - The readings to merge, in order.
 * @param now - The moment of the write.
 * @param accountId - The registry id, used when `existing` is `null`.
 */
export function mergeLedger(
  existing: UsageLedger | null,
  observations: LedgerObservation[],
  now: Date,
  accountId: string
): MergeLedgerResult {
  const windows: Record<string, LedgerEntry> = { ...(existing?.windows ?? {}) };
  const dropped: DroppedObservation[] = [];
  let changed = false;

  for (const observation of observations) {
    const { key, ...rest } = observation;
    if (typeof key !== 'string' || !WINDOW_KEY_PATTERN.test(key)) {
      dropped.push({ key: String(key), reason: 'invalid window key' });
      continue;
    }
    const candidate =
      typeof rest.usedPct === 'number' && Number.isFinite(rest.usedPct)
        ? { ...rest, usedPct: Math.min(100, Math.max(0, rest.usedPct)) }
        : rest;
    const parsed = LedgerEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      dropped.push({ key, reason: 'invalid entry' });
      continue;
    }
    const entry = parsed.data;
    const observedMs = Date.parse(entry.observedAt);
    if (observedMs - now.getTime() > MAX_FUTURE_SKEW_MS) {
      dropped.push({ key, reason: 'observedAt more than 5 minutes in the future' });
      continue;
    }
    const stored = windows[key];
    // A stored entry whose own time cannot be read loses to any valid reading.
    const storedMs = stored ? Date.parse(stored.observedAt) : Number.NaN;
    if (stored && !Number.isNaN(storedMs) && observedMs <= storedMs) continue;
    windows[key] = entry;
    changed = true;
  }

  if (existing && !changed) return { ledger: existing, changed: false, dropped };

  const ledger: UsageLedger = existing
    ? { ...existing, windows, updatedAt: changed ? now.toISOString() : existing.updatedAt }
    : { v: 1, accountId, updatedAt: now.toISOString(), windows };
  return { ledger, changed, dropped };
}

/**
 * The ledger window key for a per-model bucket: `model:` plus the model's
 * display name slugged (lowercase, every run outside `[a-z0-9._-]` becomes
 * `-`, trimmed of `-`). `'Fable'` → `'model:fable'`. `null` when nothing
 * usable is left, or the slug does not start with `[a-z0-9]`.
 *
 * @param displayName - The model's display name, as the source reported it.
 */
export function modelWindowKey(displayName: string): string | null {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '' || !/^[a-z0-9]/.test(slug)) return null;
  return `model:${slug}`;
}

// === The wire shape for one account ===

/**
 * One account's usage as every surface serves it: identity, resolved color,
 * the windows readable now, and a single state for a chip.
 */
export const AccountUsageSchema = z
  .object({
    /** Registry id, or `null` for an unregistered root (the inherited default). */
    accountId: z.string().nullable(),
    /** The account's Claude config directory. */
    path: z.string(),
    /** What the operator calls the account, or `null` when unnamed. */
    label: z.string().nullable(),
    /** The resolved display color, never `null`. */
    color: z.string(),
    /** The plan a usage call reported, held in memory only; `null` until one does. */
    subscriptionType: z.string().nullable(),
    /** The readable windows, stale ones left out, in display order. */
    windows: z.array(
      z.object({
        /** `five_hour`, `seven_day`, `seven_day_opus`, …, or `model:<slug>`. */
        key: z.string(),
        /** The window's display label, such as `5-hour window` or `Weekly`. */
        label: z.string(),
        /** Share used after {@link readWindow}, or `null` when the source gave none. */
        usedPct: z.number().nullable(),
        /** When the window resets, or `null` when unknown. */
        resetsAt: z.string().nullable(),
        /** The reported status after {@link readWindow}. */
        status: RateLimitStatusSchema.nullable(),
        /** True when the window already reset, so the reading is a fresh 0. */
        expired: z.boolean(),
        /** When the source observed the reading. */
        observedAt: z.string(),
        /** Which source produced the reading. */
        source: z.enum(LEDGER_SOURCES),
      })
    ),
    /**
     * `unknown` with no readable window, `limited` when a window is rejected,
     * `warning` when any window is at 90% or more or reports `allowed_warning`,
     * else `ok`.
     */
    state: z.enum(['ok', 'warning', 'limited', 'unknown']),
    /** The first readable window that rejected work, or `null`. */
    limit: z.object({ window: z.string(), resetsAt: z.string().nullable() }).nullable(),
    /** The ledger's last write, or `null` when there is no ledger. */
    updatedAt: z.string().nullable(),
  })
  .openapi('AccountUsage');

/** Inferred type for {@link AccountUsageSchema}. */
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

/** The identity half of an {@link AccountUsage}, already resolved by the caller. */
export interface AccountUsageIdentity {
  /** Registry id, or `null` for an unregistered root. */
  accountId: string | null;
  /** The account's Claude config directory. */
  path: string;
  /** What the operator calls the account, or `null`. */
  label: string | null;
  /** The resolved display color (see {@link resolveAccountColor}). */
  color: string;
}

const KNOWN_WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_oauth_apps: 'Weekly OAuth apps',
  overage: 'Extra usage',
};

/** The display label for a window key; an unknown key labels itself. */
function windowLabel(key: string): string {
  if (key.startsWith('model:')) return `Weekly ${key.slice('model:'.length)}`;
  return WINDOW_LABELS[key] ?? key;
}

/** Sort rank: the four known windows, then other keys, then model buckets. */
function windowRank(key: string): number {
  const known = KNOWN_WINDOW_ORDER.indexOf(key);
  if (known !== -1) return known;
  return key.startsWith('model:') ? KNOWN_WINDOW_ORDER.length + 1 : KNOWN_WINDOW_ORDER.length;
}

function compareWindowKeys(a: string, b: string): number {
  const rank = windowRank(a) - windowRank(b);
  if (rank !== 0) return rank;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The share of a window at which an account's chip turns to a warning. */
const WARNING_USED_PCT = 90;

/**
 * Build the wire shape for one account from its ledger, read at `now`.
 *
 * Stale windows are left out. `limit` is the first readable window (in display
 * order) whose status is `rejected`. `state` is `unknown` with no readable
 * window, `limited` with a `limit`, `warning` when any window's `usedPct` is
 * 90 or more or its status is `allowed_warning`, else `ok`.
 *
 * @param ledger - The account's ledger, or `null` when it has none.
 * @param identity - Who the account is, with its color already resolved.
 * @param now - The moment to read at.
 * @param subscriptionType - The plan a usage call reported, if any.
 */
export function toAccountUsage(
  ledger: UsageLedger | null,
  identity: AccountUsageIdentity,
  now: Date,
  subscriptionType: string | null = null
): AccountUsage {
  const keys = Object.keys(ledger?.windows ?? {}).sort(compareWindowKeys);
  const windows: AccountUsage['windows'] = [];
  for (const key of keys) {
    const read = readWindow(key, ledger!.windows[key]!, now);
    if (!read) continue;
    windows.push({
      key,
      label: windowLabel(key),
      usedPct: read.usedPct,
      resetsAt: read.resetsAt,
      status: read.status,
      expired: read.expired,
      observedAt: read.observedAt,
      source: read.source,
    });
  }

  const rejected = windows.find((w) => w.status === 'rejected');
  const limit = rejected ? { window: rejected.key, resetsAt: rejected.resetsAt } : null;
  let state: AccountUsage['state'];
  if (windows.length === 0) state = 'unknown';
  else if (limit) state = 'limited';
  else if (
    windows.some(
      (w) => (w.usedPct !== null && w.usedPct >= WARNING_USED_PCT) || w.status === 'allowed_warning'
    )
  )
    state = 'warning';
  else state = 'ok';

  return {
    accountId: identity.accountId,
    path: identity.path,
    label: identity.label,
    color: identity.color,
    subscriptionType,
    windows,
    state,
    limit,
    updatedAt: ledger?.updatedAt ?? null,
  };
}
