/**
 * Naming for Claude Code accounts — the Claude config directories DorkOS runs
 * work on (spec `claude-code-accounts`).
 *
 * An account's identity is its absolute path, which is the wrong thing to show a
 * person: `/Users/you/.claude2` does not say which client the work bills to, and
 * it is far too long for a list row. This module is the single place that turns a
 * path into something readable, so the sidebar badge, the status-bar switcher,
 * and the settings card all name the same account the same way.
 *
 * It also holds the pure display helpers for an account's usage (spec
 * `claude-account-ui` §5): bar tones, the chip state, and the reset and limit
 * wording every surface shares.
 *
 * @module shared/lib/claude-accounts
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { SessionLimit } from '@dorkos/shared/session-stream';

/** A registered account as `GET /api/config` reports it. */
export interface ClaudeAccountRef {
  /**
   * The registry id an agent or a session launch hint names this account by
   * (`runtimes.claudeCode.accounts[].id`, spec `billing-account-ladder`).
   *
   * `null` — or absent, on a row this client synthesized — marks a root nobody
   * registered: the inherited `$CLAUDE_CONFIG_DIR` or `~/.claude`. Such a row is
   * display-only. Nothing may point at it, so a picker that produces a REFERENCE
   * must offer only rows with an id; a picker that produces a PATH (the settings
   * default) may offer them all.
   */
  id?: string | null;
  /** Absolute path of the account's Claude config directory. */
  path: string;
  /** What the operator calls this account, or `null` when unnamed. */
  label: string | null;
  /**
   * Whether the server can currently find a Claude account in that folder — it
   * exists AND holds a `projects/` directory (the structural check, spec D4).
   * `false` means the folder contributes no sessions, and every surface that
   * offers the account has to say so rather than present it as ordinary.
   *
   * `undefined` means nobody reported on it: the account in USE when the operator
   * never registered it, which the server only names as a path.
   */
  isAccountRoot?: boolean;
}

/**
 * The shortest honest name for an account.
 *
 * The operator's label wins, because "Acme Corp" is the answer to the question
 * they are actually asking. With no label the folder name stands in
 * (`/Users/you/.claude2` reads as `.claude2`) — recognizable, and short enough
 * for a badge in a list row, where a full absolute path would swamp the title
 * next to it.
 *
 * @param path - Absolute path of the account directory.
 * @param accounts - Registered accounts to look the label up in.
 * @returns The label, else the folder name, else the path unchanged.
 */
export function claudeAccountName(path: string, accounts: readonly ClaudeAccountRef[]): string {
  const label = accounts.find((account) => account.path === path)?.label;
  if (label) return label;
  return folderName(path);
}

/**
 * The accounts a picker must offer: the registered ones, plus the account
 * currently in use when nobody registered it.
 *
 * That last case is ordinary rather than exotic — `defaultAccount` can be set by
 * hand in `~/.dork/config.json` (the configuration guide shows exactly that), and
 * the server honors it whether or not it is on the roster. A picker built from
 * the roster alone would then have no option matching the current value and would
 * render blank, which is the one thing this control must never do.
 *
 * @param accounts - Registered accounts.
 * @param inUse - The account in use, or `undefined`/`null` when it is inherited.
 * @returns The registered accounts, with `inUse` appended if it is missing.
 */
export function claudeAccountOptions(
  accounts: readonly ClaudeAccountRef[],
  inUse: string | undefined | null
): ClaudeAccountRef[] {
  const options = accounts.map((account) => ({
    id: account.id ?? null,
    path: account.path,
    label: account.label,
    isAccountRoot: account.isAccountRoot,
  }));
  if (inUse && !options.some((option) => option.path === inUse)) {
    // `id: null` because nobody registered this root, so nothing can REFERENCE
    // it — only a path-valued picker may offer it. No `isAccountRoot` either: the
    // server reports that check for REGISTERED accounts only, and claiming a
    // verdict nobody made would be worse than saying nothing.
    options.push({ id: null, path: inUse, label: null, isAccountRoot: undefined });
  }
  return options;
}

/**
 * Whether a path names a folder on the machine the SERVER runs on, which is the
 * only place a Claude account exists.
 *
 * Both spellings count, because the cockpit cannot see which platform the server
 * is on: a POSIX root (`/Users/you/.claude2`) and a Windows drive or network root
 * (`C:\Users\you\.claude2`, `\\host\share\claude`). A leading `~` does NOT count:
 * nothing between the field and the config file expands it, so `~/.claude2` would
 * be stored verbatim and register a folder that is not there.
 *
 * @param candidate - The path a person typed.
 * @returns True when the path is absolute for some platform the server may run on.
 */
export function isAbsoluteAccountPath(candidate: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(candidate);
}

/**
 * Last path segment, ignoring a trailing separator. Returns the input unchanged
 * when it has no segment to take (`'/'`, `''`).
 *
 * Splits on BOTH separators: an account folder is a server-side path, and on
 * Windows (a shipped download target) `C:\Users\dev\.claude2` split on `/` alone
 * yields the whole path — which would then be rendered as a badge and read aloud
 * as an account name.
 */
function folderName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}

// === Usage display (spec `claude-account-ui` §5) ===
//
// Pure display text and tones for an account's usage. The server decides every
// state (the limit, eligibility, the recommended account); these helpers only
// turn what it serves into words, so the chip, the picker and the banner say
// the same thing the same way.

/** One usage window of an account, as the server serves it. */
export type AccountWindow = AccountUsage['windows'][number];

/**
 * The window with key `key` on an account's usage.
 *
 * @param usage - The account's usage, or nothing when it has not loaded.
 * @param key - The window key, such as `five_hour`.
 * @returns The window, or `null` when the account has no reading for it.
 */
export function accountWindow(
  usage: AccountUsage | null | undefined,
  key: string
): AccountWindow | null {
  return usage?.windows.find((entry) => entry.key === key) ?? null;
}

/** The tone a usage bar is drawn in. `unknown` is never drawn as an empty bar. */
export type BarTone = 'unknown' | 'error' | 'warning' | 'success';

/** The share of a window at which a usage bar turns amber (both decided mockups). */
const BAR_WARNING_PCT = 70;

/**
 * The tone of a usage bar: `error` when the window rejected work or is full,
 * `warning` from 70%, `success` below that, and `unknown` with no reading. The
 * chip's own amber rule is separate: the server's 90%.
 *
 * @param entry - The window, or `null` when the account has no reading for it.
 */
export function barTone(entry: AccountWindow | null | undefined): BarTone {
  if (!entry) return 'unknown';
  if (entry.status === 'rejected') return 'error';
  if (entry.usedPct === null) return 'unknown';
  if (entry.usedPct >= 100) return 'error';
  if (entry.usedPct >= BAR_WARNING_PCT) return 'warning';
  return 'success';
}

/**
 * Where a session limit stands, as S4 names it (spec `claude-account-fleet` D9,
 * "The states core emits"). Mirrors the server's `LimitState`: a server that
 * does not send `state` yet is read through {@link limitStateOf}.
 */
export type LimitState =
  | 'limited'
  | 'wait-only'
  | 'model-limited'
  | 'all-accounts-out'
  | 'handing-off'
  | 'moved'
  | 'waiting-reset'
  | 'reset-ready';

/**
 * A session limit as the client reads it: the shared shape, plus the fields a
 * newer server adds (`scope`, `state`). Each is optional here so an older
 * server's limit still reads; {@link limitStateOf} and {@link limitScopeOf}
 * fill them in.
 */
export type SessionLimitView = SessionLimit & {
  /** `model` when only one model's window ran out; `account` when absent. */
  scope?: 'account' | 'model';
  /** Where the limit stands; derived from the plan when absent. */
  state?: LimitState;
};

/**
 * Where a session limit stands. The server's `state` when it sends one, else
 * the state its plan implies: `continued` is `moved`, `auto` is `handing-off`,
 * `waiting` is `waiting-reset`, and `ask` is `limited`.
 *
 * @param limit - The session's usage limit.
 */
export function limitStateOf(limit: SessionLimitView): LimitState {
  if (limit.state) return limit.state;
  switch (limit.plan.mode) {
    case 'continued':
      return 'moved';
    case 'auto':
      return 'handing-off';
    case 'waiting':
      return 'waiting-reset';
    default:
      return 'limited';
  }
}

/**
 * Whether a session limit is the whole account (`account`) or one model on it
 * (`model`). A server that does not send `scope` means the whole account.
 *
 * @param limit - The session's usage limit.
 */
export function limitScopeOf(limit: SessionLimitView): 'account' | 'model' {
  return limit.scope ?? 'account';
}

/**
 * What an account chip shows: `out` when the session's account ran out,
 * `model-out` when only one model on it did, `near` when it is close,
 * `unknown` with no reading, else `ok`.
 */
export type ChipState = 'ok' | 'near' | 'out' | 'model-out' | 'unknown';

/**
 * The chip state for a session's account.
 *
 * A session limit reads `out` until the work moved to another session (state
 * `moved`), or `model-out` when the limit's scope is one model: the account
 * still has room, in every state including a wait. An account the server reads
 * as `limited` is `out` too. `near` is the server's `warning` (any window at
 * 90% or more, or `allowed_warning`), so that threshold lives in one place. No
 * clock: the server recomputes the limit.
 *
 * @param usage - The account's usage, or nothing when it has not loaded.
 * @param limit - The session's usage limit, or nothing when it has none.
 */
export function chipState(
  usage: AccountUsage | null | undefined,
  limit: SessionLimitView | null | undefined
): ChipState {
  if (limit && limitStateOf(limit) !== 'moved') {
    return limitScopeOf(limit) === 'model' ? 'model-out' : 'out';
  }
  if (usage?.state === 'limited') return 'out';
  if (usage?.state === 'warning') return 'near';
  if (!usage || usage.state === 'unknown') return 'unknown';
  return 'ok';
}

/** The model families a weekly model bucket names. */
const MODEL_BUCKET_FAMILIES: Record<string, string> = {
  seven_day_opus: 'opus',
  seven_day_sonnet: 'sonnet',
};

/**
 * The name of the model a model-scope window limits, for the chip's
 * `Opus out until Tue 3pm`: `seven_day_opus` is Opus, `seven_day_sonnet` is
 * Sonnet, and `model:<slug>` is that model. The runtime's model list supplies
 * the display name (the first word of a matching model's name, when it names
 * the family); the family or slug, capitalized, stands in without one.
 *
 * @param windowKey - The window that ran out, such as `seven_day_opus`.
 * @param models - The runtime's models, as the model list serves them.
 */
export function modelBucketName(
  windowKey: string,
  models: readonly { value: string; displayName: string }[] = []
): string {
  const family = MODEL_BUCKET_FAMILIES[windowKey];
  if (family) {
    const match = models.find((model) => model.value.toLowerCase().includes(family));
    const firstWord = match?.displayName.split(/\s+/)[0];
    return firstWord && firstWord.toLowerCase() === family ? firstWord : capitalize(family);
  }
  if (windowKey.startsWith('model:')) {
    const slug = windowKey.slice('model:'.length);
    return models.find((model) => model.value === slug)?.displayName ?? capitalize(slug);
  }
  return capitalize(windowKey);
}

/**
 * The readable window closest to its limit, for the chip's near text: the
 * highest `usedPct`, ties going to `five_hour`, then to the server's window
 * order (the order `windows` arrives in).
 *
 * @param usage - The account's usage, or nothing when it has not loaded.
 * @returns The window, or `null` when no window has a reading.
 */
export function nearestWindow(usage: AccountUsage | null | undefined): AccountWindow | null {
  let nearest: AccountWindow | null = null;
  for (const entry of usage?.windows ?? []) {
    if (entry.usedPct === null) continue;
    const best = nearest?.usedPct ?? -1;
    if (entry.usedPct > best || (entry.usedPct === best && entry.key === 'five_hour')) {
      nearest = entry;
    }
  }
  return nearest;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Whole calendar days from `now`'s local date to `date`'s local date. */
function calendarDaysBetween(now: Date, date: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(date) - day(now)) / DAY_MS);
}

/**
 * Local time as `2:10pm` or `3pm`: minutes dropped at `:00`, lowercase am/pm, no space.
 *
 * The parts are always joined hour, minutes, period: the house short form of an
 * English UI. A locale that puts the period first (ja, ko, zh) would read oddly,
 * so revisit this when the app is translated.
 */
function timeOfDay(date: Date, locale: string | undefined): string {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const minute = part('minute');
  const period = part('dayPeriod').toLowerCase().replace(/[.\s]/g, '');
  return `${part('hour')}${minute && minute !== '00' ? `:${minute}` : ''}${period}`;
}

/** The short weekday name of `date` in `locale`, such as `Tue`. */
function weekday(date: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
}

/**
 * When a window resets, in local time: `2:10pm` on the same calendar day,
 * `Tue 3pm` within six days, else `Oct 3`. Day and month names follow
 * `locale`.
 *
 * @param iso - The reset time, ISO-8601, or `null` when unknown.
 * @param now - The moment to read from.
 * @param locale - The locale for day and month names; the runtime's default when absent.
 * @returns The text, or `null` when the reset is unknown.
 */
export function formatResetTime(iso: string | null, now: Date, locale?: string): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  const days = calendarDaysBetween(now, date);
  if (days === 0) return timeOfDay(date, locale);
  if (Math.abs(days) <= 6) return `${weekday(date, locale)} ${timeOfDay(date, locale)}`;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

/**
 * The day a window resets, for the picker's "28% left · resets Sun": the
 * weekday, or the time (`3pm`) when it resets today.
 *
 * @param iso - The reset time, ISO-8601, or `null` when unknown.
 * @param now - The moment to read from.
 * @param locale - The locale for the weekday name; the runtime's default when absent.
 * @returns The text, or `null` when the reset is unknown.
 */
export function formatResetDay(iso: string | null, now: Date, locale?: string): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return calendarDaysBetween(now, date) === 0 ? timeOfDay(date, locale) : weekday(date, locale);
}

/**
 * A wait under a day, as `47 min`, `1h 12m` or `2h`. Rounds up to the next
 * minute and never says less than `1 min`. For a day or more, callers use
 * {@link formatResetTime} instead.
 *
 * @param ms - The wait in milliseconds.
 */
export function formatBackIn(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * How long an account is out, in the words the chip, the picker's out rows and
 * the banner all use: `back in 47 min` for the 5-hour window resetting within a
 * day, `out until Tue 3pm` for any other window or a later reset, and `out`
 * when the reset is unknown.
 *
 * @param windowKey - The window that ran out, such as `five_hour`.
 * @param resetsAt - When it resets, ISO-8601, or `null` when unknown.
 * @param now - The moment to read from.
 * @param locale - The locale for day and month names; the runtime's default when absent.
 */
export function limitText(
  windowKey: string,
  resetsAt: string | null,
  now: Date,
  locale?: string
): string {
  if (resetsAt === null) return 'out';
  const wait = Date.parse(resetsAt) - now.getTime();
  if (windowKey === 'five_hour' && wait < DAY_MS) return `back in ${formatBackIn(wait)}`;
  return `out until ${formatResetTime(resetsAt, now, locale)}`;
}

const WINDOW_SHORT_NAMES: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'week (Opus)',
  seven_day_sonnet: 'week (Sonnet)',
};

/**
 * A window's short name for tight rows: `5h`, `week`, `week (Opus)`, or
 * `week (<Model>)` for a `model:<slug>` bucket. Any other key uses the
 * server's label.
 *
 * @param key - The window key.
 * @param serverLabel - The label the server serves for the window.
 */
export function windowShortName(key: string, serverLabel: string): string {
  const known = WINDOW_SHORT_NAMES[key];
  if (known) return known;
  if (key.startsWith('model:')) return `week (${capitalize(key.slice('model:'.length))})`;
  return serverLabel;
}

/**
 * An account's plan as a person reads it: `Max plan`, `Pro plan`, or any other
 * plan capitalized with ` plan`. Callers pass
 * `usage.plan?.name ?? usage.subscriptionType`.
 *
 * @param plan - The plan's name, or nothing when no source reported one.
 * @returns The text, or `null` so the caller leaves it out.
 */
export function planName(plan: string | null | undefined): string | null {
  if (!plan) return null;
  return `${capitalize(plan)} plan`;
}

/**
 * Who ran out, for the out-of-usage banner and its transcript marker: the
 * account's label when accounts are told apart on this runtime (the identity
 * gate is open) and the account has one, else the runtime's name (`Claude`,
 * `Codex`, `OpenCode`), which is what a person with one account knows.
 *
 * @param input - The session's runtime, its account's label, and whether the identity gate is open.
 */
export function limitSubject(input: {
  runtime: string;
  accountLabel: string | null;
  identityGate: boolean;
}): string {
  if (input.identityGate && input.accountLabel) return input.accountLabel;
  return runtimeDisplayName(input.runtime);
}

/** How old a reading may be before it is stale. */
const STALE_AFTER_MS = HOUR_MS;

/**
 * How fresh a reading is: `just now` under a minute, then `as of 12 min ago`,
 * `as of 2h ago`, and past a day `as of <day and time>` (see
 * {@link formatResetTime}).
 *
 * @param observedAt - When the reading was observed, ISO-8601.
 * @param now - The moment to read from.
 * @param locale - The locale for day and month names; the runtime's default when absent.
 */
export function formatAsOf(observedAt: string, now: Date, locale?: string): string {
  const age = now.getTime() - Date.parse(observedAt);
  if (age < MINUTE_MS) return 'just now';
  if (age < HOUR_MS) return `as of ${Math.floor(age / MINUTE_MS)} min ago`;
  if (age < DAY_MS) return `as of ${Math.floor(age / HOUR_MS)}h ago`;
  return `as of ${formatResetTime(observedAt, now, locale)}`;
}

/**
 * Whether a reading is older than an hour, so a surface marks it stale.
 *
 * @param observedAt - When the reading was observed, ISO-8601.
 * @param now - The moment to read from.
 */
export function isStale(observedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(observedAt) > STALE_AFTER_MS;
}

/** `sonnet` becomes `Sonnet`. */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
