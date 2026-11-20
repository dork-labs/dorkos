/**
 * What a `config_patch` approval card says (DOR-4775): a count on the sentence,
 * and every setting the patch changes in the detail, riskiest first.
 *
 * The card used to carry the settings as one `path: value` line on its
 * sentence, in the agent's own key order. The sentence caps every value at 80
 * characters, so twenty long harmless keys sent first pushed `tunnel.enabled`
 * past the cut, and a person approved a change they could not see. Now the
 * order is the server's, fixed by what each setting guards, and no setting is
 * ever left off the list.
 *
 * Each line reads old → new when the caller passes the stored config, so a
 * person sees what changes, not only where (DOR-4775 PR 2): a list says what it
 * adds and removes, by name, an account id reads as its label, and a secret
 * says only that it is set, changed or cleared.
 *
 * Pure: reads the policy tables and the config it is handed, never the store.
 *
 * @module services/core/operator/config-patch-card
 */
import { APPROVAL_DETAIL_STORED_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import { CREDITS_ACCOUNT_ID, IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { isSecretInputKey } from '@dorkos/shared/capabilities';
import { visibleHookValue } from '../../harness/hook-card.js';
import { redactSecretsInText } from '../approvals/approval-summary.js';
import { OPERATOR_ONLY_CONFIG_PATHS } from './config-write-policy.js';
import { matchGuardedPaths, prepareGuardedPaths } from './guarded-paths.js';
import { OPERATOR_ONLY_STAKES, type OperatorOnlyStake } from './operator-only-stakes.js';

/**
 * Where each operator-only stake sorts on the card: lower is listed first.
 *
 * 0 is the account the work runs on and who pays; 1 is who can reach this
 * computer and what leaves it; 2 is whether a person is asked first; 3 is which
 * code runs; 4 is every other setting only a person may change. A `Record`, so
 * a new stake cannot reach the card without being ranked here.
 */
export const CONFIG_PATCH_STAKE_RANK: Readonly<Record<OperatorOnlyStake, number>> = {
  credentials: 0,
  reach: 1,
  disclosure: 1,
  approvals: 2,
  code: 3,
  initiative: 4,
  resources: 4,
  attention: 4,
  authorship: 4,
  navigation: 4,
  view: 4,
};

/** The rank of a secret-named leaf, at most: it sorts with reach and disclosure. */
export const CONFIG_PATCH_SECRET_RANK = 1;

/** The rank of an operator-only path with no stake on file (the drift guard keeps it rare). */
export const CONFIG_PATCH_UNSTAKED_RANK = 4;

/** The rank of a setting an agent may change alone: listed last. */
export const CONFIG_PATCH_AGENT_RANK = 5;

/** Longest a value is shown on one line; the line itself is never dropped. */
export const CONFIG_PATCH_VALUE_MAX_LENGTH = 80;

/**
 * Longest detail this card writes. Below the store's cut, with room for the
 * redaction sweep the store runs first, so the store never shortens it.
 */
export const CONFIG_PATCH_DETAIL_MAX_LENGTH = APPROVAL_DETAIL_STORED_MAX_LENGTH - 1_000;

/** A key segment shown as is; any other is shown quoted, in brackets. */
const PLAIN_SEGMENT = /^[A-Za-z0-9_$-]+$/;

const GUARDED = prepareGuardedPaths(OPERATOR_ONLY_CONFIG_PATHS);

const STAKE_OF_PATH: ReadonlyMap<string, OperatorOnlyStake> = new Map(
  OPERATOR_ONLY_STAKES.flatMap((group) => group.paths.map((path) => [path, group.stake] as const))
);

/** One setting a patch changes, as the card lists it. */
interface PatchLine {
  /** The path as shown: plain segments dotted, any other quoted in brackets. */
  readonly path: string;
  /** The short name the sentence uses; see {@link sentenceName}. */
  readonly name: string;
  /** The value as shown, or absent when only the path is listed. */
  readonly value?: string;
  /** Where it sorts; see {@link CONFIG_PATCH_STAKE_RANK}. */
  readonly rank: number;
  /** Whether only a person may change it. */
  readonly needsPerson: boolean;
}

/** Cut a shown text to `max` characters, marking the cut. */
function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A key path as shown: no key can carry a raw newline or pass for two. Swept
 * for anything token-shaped BEFORE any cut, since a cut token stops matching
 * the sweep (`quoteSummaryValue` records the same order).
 */
function showPath(segments: readonly string[]): string {
  return segments
    .map((raw, index) => {
      const segment = redactSecretsInText(raw);
      if (!PLAIN_SEGMENT.test(segment)) return `[${visibleHookValue(segment)}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join('');
}

/**
 * A setting's name in the card's sentence: its last two plain segments, any
 * bracketed key dropped (`projectAccounts.allow`, `inference.credentialEndpoint`),
 * never cut. The detail under it gives every path whole. A path with no plain
 * segment at all is named by the whole path.
 */
function sentenceName(segments: readonly string[]): string {
  const plain = segments.map(redactSecretsInText).filter((s) => PLAIN_SEGMENT.test(s));
  return plain.length === 0 ? showPath(segments) : plain.slice(-2).join('.');
}

/**
 * A leaf value as shown: strings swept, then quoted and escaped, so one cannot
 * pass for a second line.
 */
function showValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return visibleHookValue(redactSecretsInText(value));
  // A number or null: nothing in it to escape.
  return String(value);
}

/**
 * The keys whose value is an address, not a secret, though the name says
 * `credential` (`runtimes.doe.inference.credentialEndpoint`): shown, as a URL
 * with any sign-in and query left off, because where the server sends a
 * request is exactly what a person needs to see. Named one by one, never by a
 * suffix: a webhook or bot URL carries its token in the path, so any other
 * secret-named address stays a secret (Security, DOR-4775 PR 2).
 */
const ADDRESS_KEYS: ReadonlySet<string> = new Set(['credentialEndpoint']);

/**
 * A URL as shown: the scheme, host and path. A user and password in it, and a
 * query or fragment, which can carry a token, are left off and the cut marked.
 */
function showAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return showValue(value);
  }
  const hidden = url.username || url.password || url.search || url.hash ? '…' : '';
  return showValue(`${url.protocol}//${url.host}${url.pathname}${hidden}`);
}

/** The name a person knows an account by: its label, else its id; Main and credits by name. */
function accountName(id: string, stored: unknown): string {
  if (id === IMPLICIT_ACCOUNT_ID) return 'Main';
  if (id === CREDITS_ACCOUNT_ID) return 'DorkOS credits';
  const rows = readPath(stored, ['runtimes', 'claudeCode', 'accounts']);
  const row = Array.isArray(rows)
    ? (rows as unknown[]).find((r) => isRecord(r) && r.id === id)
    : undefined;
  const label = isRecord(row) && typeof row.label === 'string' ? row.label : '';
  return label || id;
}

/** Whether a value is a plain object, not a list. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The value at a path in the stored config, or `undefined` when it has none. */
function readPath(stored: unknown, segments: readonly string[]): unknown {
  let node = stored;
  for (const segment of segments) {
    if (!isRecord(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Whether a path holds account ids: a project's allow list. */
function holdsAccountIds(segments: readonly string[]): boolean {
  const n = segments.length;
  return n >= 4 && segments[n - 1] === 'allow' && segments[n - 3] === 'projectAccounts';
}

/** What an item of a list is matched by across old and new: its id field, else itself. */
function itemKey(item: unknown): string {
  if (isRecord(item)) {
    for (const field of ['slug', 'id', 'name'] as const) {
      if (typeof item[field] === 'string') return `${field}:${item[field]}`;
    }
  }
  return JSON.stringify(item) ?? String(item);
}

/**
 * An item of a list as shown: a string quoted (an account id as its name), an
 * entry by its name with its address or folder beside it, never any other
 * field, so nothing secret inside an entry reaches the card.
 */
function showItem(item: unknown, accounts: boolean, stored: unknown): string {
  if (typeof item === 'string') return showValue(accounts ? accountName(item, stored) : item);
  if (!isRecord(item)) return item === undefined ? 'nothing' : showValue(item);
  const name = ['displayName', 'label', 'name', 'slug', 'id']
    .map((field) => item[field])
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  const where =
    typeof item.url === 'string'
      ? showAddress(item.url)
      : typeof item.path === 'string'
        ? showValue(item.path)
        : '';
  const shown = name === undefined ? 'an entry' : showValue(name);
  return where ? `${shown} at ${where}` : shown;
}

/** A list as shown: its items, or what changed when the old list is known. */
function showList(
  next: readonly unknown[],
  old: unknown,
  accounts: boolean,
  stored: unknown
): string {
  const show = (item: unknown) => showItem(item, accounts, stored);
  if (!Array.isArray(old)) return next.length === 0 ? 'empty' : next.map(show).join(', ');
  const before = new Map(old.map((item) => [itemKey(item), item] as const));
  const after = new Map(next.map((item) => [itemKey(item), item] as const));
  const parts: string[] = [];
  for (const [key, item] of after) {
    if (!before.has(key)) parts.push(`adds ${show(item)}`);
    else if (JSON.stringify(before.get(key)) !== JSON.stringify(item))
      parts.push(`changes ${show(item)}`);
  }
  for (const [key, item] of before) if (!after.has(key)) parts.push(`removes ${show(item)}`);
  return parts.length === 0 ? 'no change' : parts.join(', ');
}

/** Whether a stored secret counts as having no value. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** A secret as shown: only whether it is set, changed or cleared, never any of it. */
function showSecret(next: unknown, old: unknown, known: boolean): string {
  if (isBlank(next)) return known && isBlank(old) ? 'no change' : 'cleared';
  if (!known || isBlank(old)) return 'set';
  return JSON.stringify(old) === JSON.stringify(next) ? 'no change' : 'changed';
}

/** A leaf as shown: `old → new` when the old value is known, else the new one. */
function showLeaf(next: unknown, old: unknown, known: boolean, address: boolean): string {
  const show = (value: unknown) =>
    address && typeof value === 'string' ? showAddress(value) : showValue(value);
  if (!known) return show(next);
  if (JSON.stringify(old) === JSON.stringify(next)) return `${show(next)} (no change)`;
  const was =
    old === undefined
      ? 'not set'
      : Array.isArray(old)
        ? 'a list'
        : isRecord(old)
          ? 'a group of settings'
          : show(old);
  return `${was} → ${show(next)}`;
}

/** Rank a path by the stakes it touches, the lowest winning. */
function rankOf(
  segments: readonly string[],
  secret: boolean
): Pick<PatchLine, 'rank' | 'needsPerson'> {
  const hits = matchGuardedPaths([segments.join('.')], GUARDED);
  const ranks = hits.map((hit) => {
    const stake = STAKE_OF_PATH.get(hit);
    return stake === undefined ? CONFIG_PATCH_UNSTAKED_RANK : CONFIG_PATCH_STAKE_RANK[stake];
  });
  if (secret) ranks.push(CONFIG_PATCH_SECRET_RANK);
  return { rank: Math.min(CONFIG_PATCH_AGENT_RANK, ...ranks), needsPerson: hits.length > 0 };
}

/**
 * Every setting a patch changes, sorted by rank and then by path, never in the
 * agent's order. Objects are walked; an empty object is listed by path only.
 * With `stored`, each value reads against the one it replaces.
 */
function patchLines(patch: unknown, stored?: unknown): PatchLine[] {
  const known = stored !== undefined;
  const lines: PatchLine[] = [];
  const walk = (value: unknown, segments: string[]): void => {
    if (isRecord(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0 && segments.length > 0) {
        lines.push({
          path: showPath(segments),
          name: sentenceName(segments),
          ...rankOf(segments, false),
        });
      }
      for (const [key, child] of entries) walk(child, [...segments, key]);
      return;
    }
    if (segments.length === 0) return;
    const key = segments[segments.length - 1]!;
    const address = ADDRESS_KEYS.has(key);
    const secret = !address && isSecretInputKey(key);
    const old = readPath(stored, segments);
    const shown = secret
      ? showSecret(value, old, known)
      : Array.isArray(value)
        ? showList(value, known ? (old ?? []) : undefined, holdsAccountIds(segments), stored)
        : showLeaf(value, old, known, address);
    lines.push({
      path: showPath(segments),
      name: sentenceName(segments),
      value: shown,
      ...rankOf(segments, secret),
    });
  };
  walk(patch, []);
  return lines.sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}

/** What a line that only a person may change ends with. */
export const CONFIG_PATCH_NEEDS_YOU_MARK = ' (needs you)';

/**
 * One line of the detail, with or without its value. The path is never cut: a
 * shortened path can make two settings read alike, or a risky one read like a
 * harmless one, so a patch whose paths do not fit is refused instead. A
 * person's setting keeps its whole value too (DOR-4778): a cut value hides a
 * tail, which is the bug this card exists to end. Only a setting an agent may
 * change alone has its value capped. A person's setting ends with
 * {@link CONFIG_PATCH_NEEDS_YOU_MARK}, outside any quotes, so a value cannot
 * fake it.
 */
function renderLine(line: PatchLine, withValue: boolean): string {
  const mark = line.needsPerson ? CONFIG_PATCH_NEEDS_YOU_MARK : '';
  if (!withValue || line.value === undefined) return `${line.path}${mark}`;
  const value =
    line.rank === CONFIG_PATCH_AGENT_RANK
      ? cap(line.value, CONFIG_PATCH_VALUE_MAX_LENGTH)
      : line.value;
  return `${line.path}: ${value}${mark}`;
}

/**
 * Every setting a patch changes, one line each, riskiest first:
 * `tunnel.enabled: no → yes (needs you)`, `ui.theme: "light" → "dark"`. Sorted
 * by {@link CONFIG_PATCH_STAKE_RANK} and then by path. Only the value of a
 * setting an agent may change alone is cut, at
 * {@link CONFIG_PATCH_VALUE_MAX_LENGTH}; a path never is, and no setting is
 * left off. Strings and odd keys are quoted and escaped, so no line can hold a
 * newline or pass for another setting.
 *
 * @param patch - The patch the call carries.
 * @param stored - The config as stored now. Without it, each line shows the new
 *   value only.
 * @returns One line per setting.
 */
export function describePatchLines(patch: unknown, stored?: unknown): string[] {
  return patchLines(patch, stored).map((line) => renderLine(line, true));
}

/** How many of the riskiest settings the sentence names. */
export const CONFIG_PATCH_SUMMARY_NAMES = 3;

/**
 * Most characters the sentence spends on names. A name is never cut, so a
 * name that would pass this is counted in "and N more" instead, and the
 * sentence stays well inside the store's summary cut.
 */
export const CONFIG_PATCH_SENTENCE_NAMES_MAX_LENGTH = 300;

/**
 * The card's sentence after the agent's name: how many settings change, how
 * many only a person may change, and the riskiest of those by short name:
 * `wants to change 9 settings. 4 need you: projectAccounts.allow,
 * tunnel.enabled, scanRoots and 1 more`. With none a person must decide, it
 * names the riskiest of all. Names only, never values (DOR-4778), and never
 * cut: one that does not fit is counted instead.
 *
 * @param patch - The patch the call carries.
 */
export function describePatchSentence(patch: unknown): string {
  const lines = patchLines(patch);
  if (lines.length === 0) return 'wants to change nothing';
  const guarded = lines.filter((line) => line.needsPerson);
  const named = guarded.length > 0 ? guarded : lines;
  const names: string[] = [];
  for (const line of named.slice(0, CONFIG_PATCH_SUMMARY_NAMES)) {
    if ([...names, line.name].join(', ').length > CONFIG_PATCH_SENTENCE_NAMES_MAX_LENGTH) break;
    names.push(line.name);
  }
  const more = named.length - names.length;
  const list =
    names.length === 0
      ? ', listed below'
      : `: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  const count = `wants to change ${lines.length} setting${lines.length === 1 ? '' : 's'}`;
  if (guarded.length === 0) return `${count}${list}`;
  return `${count}. ${guarded.length} need${guarded.length === 1 ? 's' : ''} you${list}`;
}

/**
 * The card's detail: {@link describePatchLines}, one per line, kept under
 * {@link CONFIG_PATCH_DETAIL_MAX_LENGTH}. When the whole list is too long, the
 * values of settings an agent may change alone drop, from the bottom, and the
 * name always stays. A person's setting is never shortened, nor is any path: a
 * patch too large even then is refused before it gets a card
 * ({@link configPatchCardFits}).
 *
 * @param patch - The patch the call carries.
 * @param stored - The config as stored now, for old → new lines.
 * @returns The detail, or an empty string when the patch changes nothing.
 */
export function describePatchDetail(patch: unknown, stored?: unknown): string {
  const lines = patchLines(patch, stored);
  const rendered = lines.map((line) => renderLine(line, true));
  let total = rendered.reduce((sum, text) => sum + text.length + 1, -1);
  for (let i = lines.length - 1; i >= 0 && total > CONFIG_PATCH_DETAIL_MAX_LENGTH; i--) {
    // A person's setting is shown whole, always; only an agent's own loses its value.
    if (lines[i]!.rank !== CONFIG_PATCH_AGENT_RANK) continue;
    const next = renderLine(lines[i]!, false);
    total += next.length - rendered[i]!.length;
    rendered[i] = next;
  }
  return rendered.join('\n');
}

/**
 * Whether {@link describePatchDetail} can list every setting the patch
 * changes within {@link CONFIG_PATCH_DETAIL_MAX_LENGTH}. `config_patch`
 * refuses a patch for which this is false before any card is made, so a card
 * never has a hidden tail a person could approve without seeing (DOR-4775).
 *
 * @param patch - The patch the call carries.
 * @param stored - The config as stored now: the card's old → new lines are
 *   longer, so the check reads the same config the card will.
 */
export function configPatchCardFits(patch: unknown, stored?: unknown): boolean {
  return describePatchDetail(patch, stored).length <= CONFIG_PATCH_DETAIL_MAX_LENGTH;
}

/** What an agent is told when its patch is too large for one card. */
export const CONFIG_PATCH_TOO_LARGE_MESSAGE =
  'This patch changes too many settings for one approval card to list them all. Split it into smaller patches.';
