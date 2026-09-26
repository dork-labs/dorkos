/**
 * Per-account Claude usage: the on-disk usage ledger shared with flow, and the
 * wire shape every surface serves for one account.
 *
 * The ledger contract (`<dorkHome>/runtimes/<runtime>/usage/<account-id>.json`) is public and
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

/**
 * The id of a runtime's one implicit account: the ambient environment (Claude
 * Code's inherited root, Codex's `CODEX_HOME`, OpenCode's configured provider)
 * when that runtime has no registered accounts. It matches
 * {@link ACCOUNT_ID_PATTERN}, so it names a ledger file like any other id.
 */
export const IMPLICIT_ACCOUNT_ID = 'default';

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

/**
 * The runtimes that keep a usage ledger, as the slugs of their ledger folders
 * (`<dorkHome>/runtimes/<runtime>/usage/`).
 */
export const LEDGER_RUNTIMES = ['claude-code', 'codex', 'opencode'] as const;

/** Inferred type for one member of {@link LEDGER_RUNTIMES}. */
export type LedgerRuntime = (typeof LEDGER_RUNTIMES)[number];

/**
 * Where a ledger reading came from. Writers convert each into one unit.
 * `rollout` is a Codex rollout's `token_count` record; `error` is a turn that
 * ended on a rate-limit or credit error (OpenCode).
 */
export const LEDGER_SOURCES = [
  'statusline',
  'sdk_event',
  'sdk_usage',
  'transcript',
  'rollout',
  'error',
] as const;

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
    /**
     * The window's length in minutes, when the source reports it (Codex does).
     * Absent means the length its key implies.
     */
    windowMinutes: z.number().int().positive().optional(),
  })
  .refine((e) => e.usedPct !== null || e.status !== null, {
    message: 'At least one of usedPct and status must be non-null',
  });

/** Inferred type for {@link LedgerEntrySchema}. */
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * A ledger window key: a known window (`five_hour`, `seven_day`, …), any
 * future snake_case window, a per-model bucket `model:<slug>`, or a window
 * known only by its length, `window:<minutes>` (a Codex window that is neither
 * 5 hours nor 7 days).
 */
export const WINDOW_KEY_PATTERN = /^(model:[a-z0-9][a-z0-9._-]*|window:[0-9]+|[a-z][a-z0-9_]*)$/;

/**
 * Prepaid credits an account reports (Codex). `balance` is the source's own
 * rendering, or `null` when it gave none.
 */
export const LedgerCreditsSchema = z
  .object({
    /** Whether the account has credits to draw on. */
    hasCredits: z.boolean(),
    /** Whether the credits are unlimited. */
    unlimited: z.boolean(),
    /** The remaining balance as the source reported it, or `null`. */
    balance: z.string().nullable(),
  })
  .openapi('LedgerCredits');

/** Inferred type for {@link LedgerCreditsSchema}. */
export type LedgerCredits = z.infer<typeof LedgerCreditsSchema>;

/**
 * Metered spend in one billing period (OpenCode): what the account's turns
 * cost since `periodStart`, and the budget when one is known.
 */
export const LedgerSpendSchema = z
  .object({
    /** Start of the period the cost adds up over, ISO-8601 (a calendar month, UTC). */
    periodStart: z.string().datetime({ offset: true }),
    /** Spend so far in the period, in USD. */
    costUsd: z.number().min(0),
    /** The period's budget in USD, when known. Reaching it makes the account limited. */
    limitUsd: z.number().positive().optional(),
    /** When the source observed this total. */
    observedAt: z.string().datetime({ offset: true }),
    /** Which source produced the total. */
    source: z.enum(LEDGER_SOURCES),
  })
  .openapi('LedgerSpend');

/** Inferred type for {@link LedgerSpendSchema}. */
export type LedgerSpend = z.infer<typeof LedgerSpendSchema>;

/**
 * One account's usage ledger file. Loose, so fields a newer writer adds
 * survive a read-modify-write by an older one.
 */
export const UsageLedgerSchema = z.looseObject({
  /** Contract version. */
  v: z.literal(1),
  /**
   * The runtime this account belongs to. Writers always write it; readers take
   * the runtime from the ledger's folder, so a file written before the field
   * existed still parses.
   */
  runtime: z.enum(LEDGER_RUNTIMES).optional(),
  /** The registry id this ledger belongs to ({@link IMPLICIT_ACCOUNT_ID} for the implicit one). */
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  /** The last write, any window. */
  updatedAt: z.string().datetime({ offset: true }),
  /** Readings by window key. */
  windows: z.record(z.string().regex(WINDOW_KEY_PATTERN), LedgerEntrySchema),
  /** The plan the source reported (Codex `plan_type`), when it reported one. */
  plan: z.string().nullable().optional(),
  /** Prepaid credits, when the source reports them. */
  credits: LedgerCreditsSchema.nullable().optional(),
  /** Metered spend in the current period, when the runtime bills per turn. */
  spend: LedgerSpendSchema.nullable().optional(),
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

/**
 * The span after which a reading with no `resetsAt` is stale: the length the
 * entry reports, else `five_hour` 5 h and every other key 7 days.
 */
function windowLengthMs(key: string, entry: LedgerEntry): number {
  if (entry.windowMinutes !== undefined) return entry.windowMinutes * 60 * 1000;
  return key === 'five_hour' ? FIVE_HOUR_MS : SEVEN_DAY_MS;
}

/**
 * Read one window at `now` (contract "Reading a window").
 *
 * - Expired (`resetsAt` set and `now ≥ resetsAt`): reads as `usedPct 0`,
 *   `status 'allowed'`, `expired: true`.
 * - Stale (`resetsAt` null and older than the window length: `windowMinutes`
 *   when the entry has it, else `five_hour` 5 h and every other key 7 days):
 *   reads as no reading, `null`.
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
  if (nowMs - Date.parse(entry.observedAt) > windowLengthMs(key, entry)) return null;
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
  /**
   * Observations set aside, with why. The rest still merged. A rejected
   * account-level reading is reported under the key `plan`, `credits` or `spend`.
   */
  dropped: DroppedObservation[];
}

/**
 * Account-level readings to merge beside the windows. Each is optional: an
 * absent field leaves the stored value alone.
 */
export interface LedgerAccountReadings {
  /** The plan the source reports, replacing the stored one when it differs. */
  plan?: string | null;
  /** Credits the source reports, replacing the stored ones when they differ. */
  credits?: LedgerCredits | null;
  /** The period's spend, replacing the stored one only when strictly later (like a window). */
  spend?: LedgerSpend;
}

/** Which ledger an observation belongs to, used when there is no ledger yet. */
export interface LedgerOwner {
  /** The account's registry id ({@link IMPLICIT_ACCOUNT_ID} for the implicit one). */
  accountId: string;
  /** The account's runtime. */
  runtime: LedgerRuntime;
}

/** Whether an `observedAt` runs more than the allowed skew past `now`. */
function isFromTheFuture(observedAt: string, now: Date): boolean {
  return Date.parse(observedAt) - now.getTime() > MAX_FUTURE_SKEW_MS;
}

/** Whether `candidate` should replace `stored`: strictly later, or stored unreadable. */
function isStrictlyLater(candidate: string, stored: string | undefined): boolean {
  if (stored === undefined) return true;
  const storedMs = Date.parse(stored);
  // A stored reading whose own time cannot be read loses to any valid one.
  return Number.isNaN(storedMs) || Date.parse(candidate) > storedMs;
}

/** Structural equality for the small JSON values a ledger holds. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
 * `spend` follows the same rules as a window; `plan` and `credits` carry no
 * time of their own and replace the stored value when they differ.
 * `updatedAt` becomes `now` only when something changed. Unknown window keys
 * and unknown top-level fields are kept.
 *
 * Pure: it never logs. Callers log `dropped`.
 *
 * @param existing - The stored ledger, or `null` when there is none yet.
 * @param observations - The window readings to merge, in order.
 * @param now - The moment of the write.
 * @param owner - The account and runtime (the ledger's folder). The runtime is
 *   written on every rewrite; the account id is used when `existing` is `null`.
 * @param account - Account-level readings (plan, credits, spend), if any.
 */
export function mergeLedger(
  existing: UsageLedger | null,
  observations: LedgerObservation[],
  now: Date,
  owner: LedgerOwner,
  account: LedgerAccountReadings = {}
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
    if (isFromTheFuture(entry.observedAt, now)) {
      dropped.push({ key, reason: 'observedAt more than 5 minutes in the future' });
      continue;
    }
    if (!isStrictlyLater(entry.observedAt, windows[key]?.observedAt)) continue;
    windows[key] = entry;
    changed = true;
  }

  const next: Partial<Pick<UsageLedger, 'plan' | 'credits' | 'spend'>> = {};

  if (account.plan !== undefined) {
    const plan = z.string().nullable().safeParse(account.plan);
    if (!plan.success) dropped.push({ key: 'plan', reason: 'invalid plan' });
    else if (plan.data !== (existing?.plan ?? null)) next.plan = plan.data;
  }

  if (account.credits !== undefined) {
    const credits = LedgerCreditsSchema.nullable().safeParse(account.credits);
    if (!credits.success) dropped.push({ key: 'credits', reason: 'invalid credits' });
    else if (!sameJson(credits.data, existing?.credits ?? null)) next.credits = credits.data;
  }

  if (account.spend !== undefined) {
    const spend = LedgerSpendSchema.safeParse(account.spend);
    if (!spend.success) dropped.push({ key: 'spend', reason: 'invalid spend' });
    else if (isFromTheFuture(spend.data.observedAt, now)) {
      dropped.push({ key: 'spend', reason: 'observedAt more than 5 minutes in the future' });
    } else if (isStrictlyLater(spend.data.observedAt, existing?.spend?.observedAt)) {
      next.spend = spend.data;
    }
  }

  if (Object.keys(next).length > 0) changed = true;
  if (existing && !changed) return { ledger: existing, changed: false, dropped };

  const ledger: UsageLedger = existing
    ? // The owner's runtime is the ledger's folder, so a rewrite always states it.
      { ...existing, ...next, runtime: owner.runtime, windows, updatedAt: now.toISOString() }
    : {
        v: 1,
        runtime: owner.runtime,
        accountId: owner.accountId,
        updatedAt: now.toISOString(),
        windows,
        ...next,
      };
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
    /** The runtime the account belongs to. */
    runtime: z.enum(LEDGER_RUNTIMES),
    /**
     * Registry id ({@link IMPLICIT_ACCOUNT_ID} for a runtime's implicit
     * account), or `null` for an unregistered root while other accounts are
     * registered.
     */
    accountId: z.string().nullable(),
    /** The account's Claude config directory. */
    path: z.string(),
    /** What the operator calls the account, or `null` when unnamed. */
    label: z.string().nullable(),
    /** The resolved display color, never `null`. */
    color: z.string(),
    /** The plan a usage call reported, held in memory only; `null` until one does. */
    subscriptionType: z.string().nullable(),
    /** The plan the ledger holds (Codex `plan_type`), or `null`. */
    plan: z.string().nullable(),
    /** Prepaid credits the ledger holds, or `null`. */
    credits: LedgerCreditsSchema.nullable(),
    /** The current period's metered spend, or `null` for an account not billed per turn. */
    spend: LedgerSpendSchema.nullable(),
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
     * `limited` when a window is rejected or the spend reached its budget,
     * `warning` when any window is at 90% or more or reports `allowed_warning`,
     * `unknown` when nothing is known (no ledger, or only stale windows and no
     * spend), else `ok` (including a ledger with neither windows nor spend: a
     * local model).
     */
    state: z.enum(['ok', 'warning', 'limited', 'unknown']),
    /**
     * The first readable window that rejected work, else the spend budget
     * (`window: 'spend'`, `resetsAt: null`) when it is reached, else `null`.
     */
    limit: z.object({ window: z.string(), resetsAt: z.string().nullable() }).nullable(),
    /** The ledger's last write, or `null` when there is no ledger. */
    updatedAt: z.string().nullable(),
  })
  .openapi('AccountUsage');

/** Inferred type for {@link AccountUsageSchema}. */
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

/** The identity half of an {@link AccountUsage}, already resolved by the caller. */
export interface AccountUsageIdentity {
  /**
   * The account's runtime, as the store knows it from the ledger's folder.
   * Wins over the ledger's own field; absent falls back to that field, then
   * `claude-code`.
   */
  runtime?: LedgerRuntime;
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

/** The first instant of `now`'s UTC calendar month. */
function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Read a spend total at `now`, the way {@link readWindow} reads a window: a
 * total whose `periodStart` is before the current UTC month belongs to a period
 * that has ended, so it reads as reset (`costUsd` 0 from the start of this
 * month, budget kept). Otherwise it reads as stored.
 *
 * @param spend - The stored spend total.
 * @param now - The moment to read at.
 */
export function readSpend(spend: LedgerSpend, now: Date): LedgerSpend {
  const monthStart = utcMonthStart(now);
  if (Date.parse(spend.periodStart) >= monthStart.getTime()) return spend;
  return { ...spend, periodStart: monthStart.toISOString(), costUsd: 0 };
}

/** The `limit.window` an account reports when its spend reached its budget. */
export const SPEND_LIMIT_WINDOW = 'spend';

/**
 * Build the wire shape for one account from its ledger, read at `now`.
 *
 * Stale windows are left out. `limit` is the first readable window (in display
 * order) whose status is `rejected`, else {@link SPEND_LIMIT_WINDOW} when
 * `spend.costUsd` reached `spend.limitUsd` in the current period (spend from
 * an earlier month reads as reset, see {@link readSpend}). `state` is `limited` with a
 * `limit`; `warning` when any window's `usedPct` is 90 or more or its status
 * is `allowed_warning`; `unknown` with no ledger, or with windows that are all
 * stale and no spend; else `ok`. A ledger with neither windows nor spend (a
 * local model) is `ok`.
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

  const spend = ledger?.spend ? readSpend(ledger.spend, now) : null;
  const rejected = windows.find((w) => w.status === 'rejected');
  const spendReached =
    spend !== null && spend.limitUsd !== undefined && spend.costUsd >= spend.limitUsd;
  const limit = rejected
    ? { window: rejected.key, resetsAt: rejected.resetsAt }
    : spendReached
      ? { window: SPEND_LIMIT_WINDOW, resetsAt: null }
      : null;
  const nothingKnown =
    ledger === null || (windows.length === 0 && keys.length > 0 && spend === null);
  let state: AccountUsage['state'];
  if (limit) state = 'limited';
  else if (nothingKnown) state = 'unknown';
  else if (
    windows.some(
      (w) => (w.usedPct !== null && w.usedPct >= WARNING_USED_PCT) || w.status === 'allowed_warning'
    )
  )
    state = 'warning';
  else state = 'ok';

  return {
    runtime: identity.runtime ?? ledger?.runtime ?? 'claude-code',
    accountId: identity.accountId,
    path: identity.path,
    label: identity.label,
    color: identity.color,
    subscriptionType,
    plan: ledger?.plan ?? null,
    credits: ledger?.credits ?? null,
    spend,
    windows,
    state,
    limit,
    updatedAt: ledger?.updatedAt ?? null,
  };
}
