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
 * Pure: reads the policy tables, never the config.
 *
 * @module services/core/operator/config-patch-card
 */
import { APPROVAL_DETAIL_STORED_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
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
 * A leaf value as shown: strings swept, then quoted and escaped, so one cannot
 * pass for a second line.
 */
function showValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return visibleHookValue(redactSecretsInText(value));
  // A number or null: nothing in it to escape.
  return String(value);
}

/** Rank a path by the stakes it touches, the lowest winning. */
function rankOf(segments: readonly string[], secret: boolean): Omit<PatchLine, 'path' | 'value'> {
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
 * agent's order. Objects are walked; an empty object, a list and a leaf whose
 * name says secret are listed by path only.
 */
function patchLines(patch: unknown): PatchLine[] {
  const lines: PatchLine[] = [];
  const walk = (value: unknown, segments: string[]): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0 && segments.length > 0) {
        lines.push({ path: showPath(segments), ...rankOf(segments, false) });
      }
      for (const [key, child] of entries) walk(child, [...segments, key]);
      return;
    }
    if (segments.length === 0) return;
    const secret = isSecretInputKey(segments[segments.length - 1]!);
    lines.push({
      path: showPath(segments),
      ...(secret || Array.isArray(value) ? {} : { value: showValue(value) }),
      ...rankOf(segments, secret),
    });
  };
  walk(patch, []);
  return lines.sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}

/**
 * One line of the detail, with or without its value. The path is never cut: a
 * shortened path can make two settings read alike, or a risky one read like a
 * harmless one, so a patch whose paths do not fit is refused instead. A
 * person's setting keeps its whole value too (DOR-4778): a cut value hides a
 * tail, which is the bug this card exists to end. Only a setting an agent may
 * change alone has its value capped.
 */
function renderLine(line: PatchLine, withValue: boolean): string {
  if (!withValue || line.value === undefined) return line.path;
  const value =
    line.rank === CONFIG_PATCH_AGENT_RANK
      ? cap(line.value, CONFIG_PATCH_VALUE_MAX_LENGTH)
      : line.value;
  return `${line.path}: ${value}`;
}

/**
 * Every setting a patch changes, one line each, riskiest first:
 * `tunnel.enabled: yes`, `ui.theme: "dark"`. Sorted by
 * {@link CONFIG_PATCH_STAKE_RANK} and then by path. Only the value of a setting
 * an agent may change alone is cut, at {@link CONFIG_PATCH_VALUE_MAX_LENGTH};
 * a path never is, and no setting is left off. Strings and odd keys are quoted and escaped, so no line can hold a
 * newline or pass for another setting.
 *
 * @param patch - The patch the call carries.
 * @returns One line per setting.
 */
export function describePatchLines(patch: unknown): string[] {
  return patchLines(patch).map((line) => renderLine(line, true));
}

/** How many of the riskiest settings the sentence names. */
export const CONFIG_PATCH_SUMMARY_NAMES = 3;

/**
 * Longest a setting's name is shown in the sentence. Short enough that the
 * first, riskiest one always sits inside the sentence's 80-character value; the
 * detail under it shows every name whole.
 */
export const CONFIG_PATCH_SUMMARY_NAME_MAX_LENGTH = 40;

/**
 * What the card's sentence carries: the riskiest settings by name, first, then
 * how many more and how many only a person may change:
 * `tunnel.enabled, mesh.scanRoots, extensions.enabled and 6 more, 4 need you`.
 * `nothing` for an empty patch. Names only, never values (DOR-4778).
 *
 * @param patch - The patch the call carries.
 */
export function describePatchSummary(patch: unknown): string {
  const lines = patchLines(patch);
  if (lines.length === 0) return 'nothing';
  const names = lines
    .slice(0, CONFIG_PATCH_SUMMARY_NAMES)
    .map((line) => cap(line.path, CONFIG_PATCH_SUMMARY_NAME_MAX_LENGTH))
    .join(', ');
  const more = lines.length - CONFIG_PATCH_SUMMARY_NAMES;
  const guarded = lines.filter((line) => line.needsPerson).length;
  return (
    names +
    (more > 0 ? ` and ${more} more` : '') +
    (guarded > 0 ? `, ${guarded} need${guarded === 1 ? 's' : ''} you` : '')
  );
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
 * @returns The detail, or an empty string when the patch changes nothing.
 */
export function describePatchDetail(patch: unknown): string {
  const lines = patchLines(patch);
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
 */
export function configPatchCardFits(patch: unknown): boolean {
  return describePatchDetail(patch).length <= CONFIG_PATCH_DETAIL_MAX_LENGTH;
}

/** What an agent is told when its patch is too large for one card. */
export const CONFIG_PATCH_TOO_LARGE_MESSAGE =
  'This patch changes too many settings for one approval card to list them all. Split it into smaller patches.';
