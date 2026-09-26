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
import { ledgerSlug } from './ledger-slug.js';

export { ledgerSlug } from './ledger-slug.js';
export { codexObservations } from './account-usage-codex.js';

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

// === The usage ledger (contract §1.2, revision 6) ===

/**
 * The runtimes that keep a usage ledger, as the slugs of their ledger folders
 * (`<dorkHome>/runtimes/<runtime>/usage/`).
 */
export const LEDGER_RUNTIMES = ['claude-code', 'codex', 'opencode'] as const;

/** Inferred type for one member of {@link LEDGER_RUNTIMES}. */
export type LedgerRuntime = (typeof LEDGER_RUNTIMES)[number];

/**
 * Where a ledger reading came from. Writers convert each into one unit.
 * `rollout` is a Codex rollout's rate limits, `sidecar` an OpenCode turn's
 * cost, `provider_api` the provider's own key API, and `error` a turn that
 * ended on a rate-limit or credit error.
 */
export const LEDGER_SOURCES = [
  'statusline',
  'sdk_event',
  'sdk_usage',
  'transcript',
  'rollout',
  'sidecar',
  'provider_api',
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
 * An ISO-8601 time with an explicit zone, as the contract's JSON Schema
 * spells it (seconds and fractions optional). Stored times are normalized to
 * UTC with milliseconds and `Z`.
 */
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const IsoTimeSchema = z
  .string()
  .regex(ISO_TIME_PATTERN)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Not a real time' });

/** Normalize a valid ISO time to UTC with milliseconds and `Z`. */
function toUtc(value: string): string {
  return new Date(value).toISOString();
}

const LedgerSourceSchema = z.enum(LEDGER_SOURCES);

/**
 * One window's reading. `observedAt` is when the SOURCE saw it, not when it was
 * written. At least one of `usedPct` and `status` must be non-null.
 */
export const LedgerEntrySchema = z
  .object({
    /** Share of the window used, 0 to 100, or `null` when the source gave none. */
    usedPct: z.number().min(0).max(100).nullable(),
    /** When the window resets, ISO-8601, or `null` when unknown. */
    resetsAt: IsoTimeSchema.nullable(),
    /** The window's length in minutes, when the source names it: an integer of 1 or more. */
    windowMinutes: z.number().int().min(1).optional(),
    /** The status the source reported, or `null` when it reported none. */
    status: RateLimitStatusSchema.nullable(),
    /** When the source observed this reading, ISO-8601 with an explicit zone. */
    observedAt: IsoTimeSchema,
    /** Which source produced the reading. */
    source: LedgerSourceSchema,
  })
  .refine((e) => e.usedPct !== null || e.status !== null, {
    message: 'At least one of usedPct and status must be non-null',
  });

/** Inferred type for {@link LedgerEntrySchema}. */
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * A ledger window key: a known window (`five_hour`, `seven_day`, …), any
 * future snake_case window, a per-model bucket `model:<slug>`, a window known
 * only by its length `window:<minutes>` (minutes ≥ 1), or a provider's
 * window-less error signal `credits:<slug>` or `rate_limit:<slug>`.
 */
export const WINDOW_KEY_PATTERN =
  /^(model:[a-z0-9][a-z0-9._-]*|credits:[a-z0-9][a-z0-9._-]*|rate_limit:[a-z0-9][a-z0-9._-]*|window:[1-9][0-9]*|[a-z][a-z0-9_]*)$/;

/** The plan an account is on, as its runtime names it (Codex `plan_type`). */
export const LedgerPlanSchema = z
  .object({
    /** The plan's name. */
    name: z.string().min(1),
    /** When the source observed it. */
    observedAt: IsoTimeSchema,
    /** Which source reported it. */
    source: LedgerSourceSchema,
  })
  .openapi('LedgerPlan');

/** Inferred type for {@link LedgerPlanSchema}. */
export type LedgerPlan = z.infer<typeof LedgerPlanSchema>;

/** Prepaid credits an account reports (Codex). */
export const LedgerCreditsSchema = z
  .object({
    /** Whether the account has credits to draw on. */
    hasCredits: z.boolean(),
    /** Whether the credits are unlimited. */
    unlimited: z.boolean(),
    /** The remaining balance as the runtime reports it, or `null`. */
    balance: z.string().nullable().default(null),
    /** When the source observed it. */
    observedAt: IsoTimeSchema,
    /** Which source reported it. */
    source: LedgerSourceSchema,
  })
  .openapi('LedgerCredits');

/** Inferred type for {@link LedgerCreditsSchema}. */
export type LedgerCredits = z.infer<typeof LedgerCreditsSchema>;

/**
 * Metered spend in one billing period (OpenCode): what the account's turns
 * cost since `periodStart`, and the cap when there is one. A spend reading
 * never goes stale in the ledger; {@link readSpend} decides what it means now.
 */
export const LedgerSpendSchema = z
  .object({
    /** Start of the period the cost adds up over, ISO-8601. */
    periodStart: IsoTimeSchema,
    /** Spend so far in the period, in USD. */
    costUsd: z.number().min(0),
    /** The period's cap in USD, or `null` with no cap. Reaching it makes the account limited. */
    limitUsd: z.number().positive().nullable().default(null),
    /** When the source observed this total. */
    observedAt: IsoTimeSchema,
    /** Which source produced the total. */
    source: LedgerSourceSchema,
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
   * The runtime this account belongs to. Every write sets it to the runtime in
   * the file's path; readers trust the path, so a file without it still reads.
   */
  runtime: z.enum(LEDGER_RUNTIMES).optional(),
  /** The registry id this ledger belongs to ({@link IMPLICIT_ACCOUNT_ID} for the implicit one). */
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  /** The last write, any window or fact. */
  updatedAt: IsoTimeSchema,
  /** Readings by window key. */
  windows: z.record(z.string().regex(WINDOW_KEY_PATTERN), LedgerEntrySchema),
  /** The account's plan, when a source reported one. */
  plan: LedgerPlanSchema.optional(),
  /** The account's prepaid credits, when a source reported them. */
  credits: LedgerCreditsSchema.optional(),
  /** The account's metered spend, when it is billed per turn. */
  spend: LedgerSpendSchema.optional(),
});

/** Inferred type for {@link UsageLedgerSchema}. */
export type UsageLedger = z.infer<typeof UsageLedgerSchema>;

/** The three account-level facts a ledger holds beside its windows. */
export const LEDGER_FACT_KINDS = ['plan', 'credits', 'spend'] as const;

/** Inferred type for one member of {@link LEDGER_FACT_KINDS}. */
export type LedgerFactKind = (typeof LEDGER_FACT_KINDS)[number];

/**
 * A window reading to merge, tagged with its window key. An omitted
 * `usedPct`, `resetsAt` or `status` reads as `null`.
 */
export type LedgerWindowObservation = { key: string } & Partial<
  Pick<LedgerEntry, 'usedPct' | 'resetsAt' | 'status' | 'windowMinutes'>
> &
  Pick<LedgerEntry, 'observedAt' | 'source'>;

/** A fact reading to merge, tagged with its kind. */
export type LedgerFactObservation =
  | ({ kind: 'plan' } & LedgerPlan)
  | ({ kind: 'credits' } & z.input<typeof LedgerCreditsSchema>)
  | ({ kind: 'spend' } & z.input<typeof LedgerSpendSchema>);

/** One reading to merge: a window (it has a `key`) or a fact (it has a `kind`). */
export type LedgerObservation = LedgerWindowObservation | LedgerFactObservation;

/** A ledger entry as read at a moment: expired windows read as reset. */
export type ReadWindow = LedgerEntry & {
  /** True when the window's `resetsAt` has passed, so the reading was reset to 0. */
  expired: boolean;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const SEVEN_DAY_MS = 7 * 24 * HOUR_MS;
/** How far past `now` an observation's clock may run before it is dropped. */
const MAX_FUTURE_SKEW_MS = 5 * MINUTE_MS;

/**
 * The span after which a reading with no `resetsAt` is stale: 1 hour for a
 * `credits:*` or `rate_limit:*` error signal; else the entry's
 * `windowMinutes`, or the minutes in a `window:<minutes>` key; else
 * `five_hour` 5 h and every other key 7 days.
 */
function windowLengthMs(key: string, entry: LedgerEntry): number {
  if (key.startsWith('credits:') || key.startsWith('rate_limit:')) return HOUR_MS;
  if (entry.windowMinutes !== undefined) return entry.windowMinutes * MINUTE_MS;
  const minutes = /^window:([1-9][0-9]*)$/.exec(key);
  if (minutes) return Number(minutes[1]) * MINUTE_MS;
  return key === 'five_hour' ? FIVE_HOUR_MS : SEVEN_DAY_MS;
}

/** Validate a stored or observed window entry and normalize its times to UTC. */
function parseEntry(value: unknown): LedgerEntry | null {
  const parsed = LedgerEntrySchema.safeParse(value);
  if (!parsed.success) return null;
  const entry = parsed.data;
  return {
    usedPct: entry.usedPct,
    resetsAt: entry.resetsAt === null ? null : toUtc(entry.resetsAt),
    ...(entry.windowMinutes !== undefined ? { windowMinutes: entry.windowMinutes } : {}),
    status: entry.status,
    observedAt: toUtc(entry.observedAt),
    source: entry.source,
  };
}

/**
 * Read one window at `now` (contract "Reading a window").
 *
 * - No entry, or an invalid one: `null`.
 * - Expired (`resetsAt` set and `now ≥ resetsAt`): reads as `usedPct 0`,
 *   `status 'allowed'`, `expired: true`.
 * - Stale (`resetsAt` null and older than the window length: 1 h for
 *   `credits:*` and `rate_limit:*`, else `windowMinutes` or the
 *   `window:<minutes>` length, else `five_hour` 5 h and every other key
 *   7 days): `null`.
 * - Otherwise: as stored.
 *
 * Times read back in UTC with milliseconds and `Z`.
 *
 * @param entry - The stored reading, as parsed from the file (validated here).
 * @param now - The moment to read at.
 * @param key - The window key, which decides the stale length.
 */
export function readWindow(entry: unknown, now: Date, key: string): ReadWindow | null {
  const parsed = parseEntry(entry);
  if (!parsed) return null;
  const nowMs = now.getTime();
  if (parsed.resetsAt !== null) {
    if (nowMs >= Date.parse(parsed.resetsAt)) {
      return { ...parsed, usedPct: 0, status: 'allowed', expired: true };
    }
    return { ...parsed, expired: false };
  }
  if (nowMs - Date.parse(parsed.observedAt) > windowLengthMs(key, parsed)) return null;
  return { ...parsed, expired: false };
}

/** A warning code {@link mergeLedger} reports, as the contract's fixtures name them. */
export type LedgerWarningCode =
  'observation-invalid' | 'observation-future' | 'ledger-invalid' | 'ledger-version-unknown';

/** One thing {@link mergeLedger} set aside or refused, for the caller's warning log. */
export interface LedgerMergeWarning {
  /** What happened. */
  code: LedgerWarningCode;
  /** The observation's window key or fact kind, when there was one. */
  key?: string;
}

/** Which ledger the observations belong to: the runtime and account in its path. */
export interface LedgerOwner {
  /** The account's runtime. */
  runtime: LedgerRuntime;
  /** The account's registry id ({@link IMPLICIT_ACCOUNT_ID} for the implicit one). */
  accountId: string;
}

/**
 * The outcome of {@link mergeLedger}. When `changed` is true, `ledger` is the
 * file to write. When it is false, nothing is written and `ledger` is the
 * input exactly as given (`null` when there was none).
 */
export type MergeLedgerResult =
  | { changed: true; ledger: UsageLedger; warnings: LedgerMergeWarning[] }
  | { changed: false; ledger: unknown; warnings: LedgerMergeWarning[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `observedAt` of a stored window or fact, or NaN when it cannot be read. */
function storedTime(stored: unknown): number {
  if (!isPlainObject(stored) || typeof stored.observedAt !== 'string') return Number.NaN;
  return ISO_TIME_PATTERN.test(stored.observedAt) ? Date.parse(stored.observedAt) : Number.NaN;
}

/** Whether an observation at `observedMs` replaces `stored`: strictly later, or stored unreadable. */
function replaces(observedMs: number, stored: unknown): boolean {
  if (stored === undefined) return true;
  const storedMs = storedTime(stored);
  return Number.isNaN(storedMs) || observedMs > storedMs;
}

/** Validate a fact observation (without its `kind`) and normalize its times. */
function parseFact(kind: LedgerFactKind, value: Record<string, unknown>) {
  if (kind === 'plan') {
    const parsed = LedgerPlanSchema.safeParse(value);
    return parsed.success ? { ...parsed.data, observedAt: toUtc(parsed.data.observedAt) } : null;
  }
  if (kind === 'credits') {
    const parsed = LedgerCreditsSchema.safeParse(value);
    return parsed.success ? { ...parsed.data, observedAt: toUtc(parsed.data.observedAt) } : null;
  }
  const parsed = LedgerSpendSchema.safeParse(value);
  return parsed.success
    ? {
        ...parsed.data,
        periodStart: toUtc(parsed.data.periodStart),
        observedAt: toUtc(parsed.data.observedAt),
      }
    : null;
}

/**
 * Merge observations into a ledger (contract "Merging").
 *
 * An observation is a window reading (it has a `key`) or a fact (it has a
 * `kind`: `plan`, `credits` or `spend`). Per window key and per fact, an
 * observation replaces the stored one only when its `observedAt` is strictly
 * later; an equal one keeps the stored one, so a replay is a no-op. A newer
 * observation always wins, even with a lower `usedPct` (the window reset). An
 * observation more than 5 minutes after `now` is dropped, so one bad clock
 * cannot pin a window; an invalid one is dropped while the rest merge. A
 * stored entry that is not valid loses to any valid observation. `usedPct` is
 * clamped to 0 to 100 before validation, and times are stored in UTC.
 *
 * The ledger's `runtime` and `accountId` are set to the owner's, and a change
 * to either rewrites the file. A ledger of another version is left alone; one
 * that is not a ledger object starts over. `updatedAt` becomes `now` only when
 * something changed. Unknown window keys and unknown fields are kept.
 *
 * Pure: it never logs. Callers log `warnings`.
 *
 * @param existing - The stored file as parsed JSON, or `null` when there is none.
 * @param observations - The readings to merge, in any order.
 * @param now - The moment of the write.
 * @param owner - The runtime and account the file's path names.
 */
export function mergeLedger(
  existing: unknown,
  observations: readonly LedgerObservation[],
  now: Date,
  owner: LedgerOwner
): MergeLedgerResult {
  const warnings: LedgerMergeWarning[] = [];
  let base: Record<string, unknown> | null = null;
  if (existing !== null && existing !== undefined) {
    if (!isPlainObject(existing) || !('v' in existing)) {
      warnings.push({ code: 'ledger-invalid' });
    } else if (existing.v !== 1) {
      return { changed: false, ledger: existing, warnings: [{ code: 'ledger-version-unknown' }] };
    } else if (!isPlainObject(existing.windows)) {
      warnings.push({ code: 'ledger-invalid' });
    } else {
      base = existing;
    }
  }

  const windows: Record<string, unknown> = { ...((base?.windows as object | undefined) ?? {}) };
  const facts: Partial<Record<LedgerFactKind, unknown>> = {};
  for (const kind of LEDGER_FACT_KINDS) if (base && kind in base) facts[kind] = base[kind];
  let changed = false;

  for (const observation of observations as readonly unknown[]) {
    if (!isPlainObject(observation)) {
      warnings.push({ code: 'observation-invalid' });
      continue;
    }
    if ('kind' in observation) {
      const { kind, ...rest } = observation;
      const label = String(kind);
      if (!(LEDGER_FACT_KINDS as readonly unknown[]).includes(kind)) {
        warnings.push({ code: 'observation-invalid', key: label });
        continue;
      }
      const fact = parseFact(kind as LedgerFactKind, rest);
      if (!fact) {
        warnings.push({ code: 'observation-invalid', key: label });
        continue;
      }
      const observedMs = Date.parse(fact.observedAt);
      if (observedMs - now.getTime() > MAX_FUTURE_SKEW_MS) {
        warnings.push({ code: 'observation-future', key: label });
        continue;
      }
      if (!replaces(observedMs, facts[kind as LedgerFactKind])) continue;
      facts[kind as LedgerFactKind] = fact;
      changed = true;
      continue;
    }
    const { key, ...rest } = observation;
    if (typeof key !== 'string' || !WINDOW_KEY_PATTERN.test(key)) {
      warnings.push({ code: 'observation-invalid', key: String(key) });
      continue;
    }
    const withNulls = {
      usedPct: null,
      resetsAt: null,
      status: null,
      ...rest,
    } as Record<string, unknown>;
    if (typeof withNulls.usedPct === 'number' && Number.isFinite(withNulls.usedPct)) {
      withNulls.usedPct = Math.min(100, Math.max(0, withNulls.usedPct));
    }
    const entry = parseEntry(withNulls);
    if (!entry) {
      warnings.push({ code: 'observation-invalid', key });
      continue;
    }
    const observedMs = Date.parse(entry.observedAt);
    if (observedMs - now.getTime() > MAX_FUTURE_SKEW_MS) {
      warnings.push({ code: 'observation-future', key });
      continue;
    }
    if (!replaces(observedMs, windows[key])) continue;
    windows[key] = entry;
    changed = true;
  }

  // The path names the runtime and account, so the file must say the same.
  if (base && (base.runtime !== owner.runtime || base.accountId !== owner.accountId)) {
    changed = true;
  }
  if (!changed) return { changed: false, ledger: existing ?? null, warnings };

  const ledger = {
    ...(base ?? {}),
    v: 1,
    runtime: owner.runtime,
    accountId: owner.accountId,
    updatedAt: now.toISOString(),
    windows,
    ...facts,
  } as UsageLedger;
  return { changed: true, ledger, warnings };
}

/**
 * The ledger window key for a per-model bucket: `model:` plus the model's
 * display name slugged by {@link ledgerSlug}. `'Fable'` → `'model:fable'`.
 * `null` when nothing usable is left.
 *
 * @param displayName - The model's display name, as the source reported it.
 */
export function modelWindowKey(displayName: string): string | null {
  const slug = ledgerSlug(displayName);
  return slug === null ? null : `model:${slug}`;
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
    plan: LedgerPlanSchema.nullable(),
    /** Prepaid credits the ledger holds, or `null`. */
    credits: LedgerCreditsSchema.nullable(),
    /** The metered spend the ledger holds, or `null` for an account not billed per turn. */
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
     * `limited` when a window is rejected or the spend reached its cap;
     * `warning` when any window is at 90% or more or reports `allowed_warning`;
     * `unknown` with no current window and no spend, except on OpenCode, where
     * that is a local model and reads `ok`; else `ok`.
     */
    state: z.enum(['ok', 'warning', 'limited', 'unknown']),
    /**
     * The first readable window that rejected work, else the spend cap
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

/** The `limit.window` an account reports when its spend reached its cap. */
export const SPEND_LIMIT_WINDOW = 'spend';

/**
 * Build the wire shape for one account from its ledger, read at `now`.
 *
 * Stale windows are left out. `limit` is the first readable window (in display
 * order) whose status is `rejected`, else {@link SPEND_LIMIT_WINDOW} when
 * `spend.limitUsd` is set and `spend.costUsd` reached it (a spend reading never
 * goes stale). `state` is `limited` with a `limit`; `unknown` with no current
 * window and no spend, except on OpenCode, where that is a local model and
 * reads `ok`; `warning` when any window's `usedPct` is 90 or more or its status
 * is `allowed_warning`; else `ok`.
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
    const read = readWindow(ledger!.windows[key], now, key);
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

  const runtime = identity.runtime ?? ledger?.runtime ?? 'claude-code';
  const spend = ledger?.spend ?? null;
  const rejected = windows.find((w) => w.status === 'rejected');
  const spendReached = spend !== null && spend.limitUsd !== null && spend.costUsd >= spend.limitUsd;
  const limit = rejected
    ? { window: rejected.key, resetsAt: rejected.resetsAt }
    : spendReached
      ? { window: SPEND_LIMIT_WINDOW, resetsAt: null }
      : null;
  // An OpenCode account with nothing to report is a local model: nothing limits it.
  const nothingKnown = windows.length === 0 && spend === null && runtime !== 'opencode';
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
    runtime,
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
