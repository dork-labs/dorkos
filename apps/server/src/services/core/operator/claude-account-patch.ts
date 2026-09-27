/**
 * How a config write treats the Claude account registry
 * (`runtimes.claudeCode.accounts`), which flow and DorkOS share (marketplace
 * `specs/flow-cli-core` §1.1a, spec `claude-account-fleet` D1).
 *
 * A PATCH replaces an array wholesale, and the settings screen builds its PATCH
 * from `GET /api/config`, which shows neither a row's unknown fields nor the
 * rows the read rules skip. Replacing the array as sent would therefore delete
 * what the client never saw: a field flow wrote onto a row, a hand-edited row
 * with a relative path. So the write path merges instead, by the rules here.
 *
 * @module services/core/operator/claude-account-patch
 */
import { ACCOUNT_ID_PATTERN, IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import {
  CLAUDE_ACCOUNTS_SEEN_KEY,
  ClaudeAccountsSeenSchema,
  classifyClaudeAccountRows,
} from '@dorkos/shared/config-schema';

/** Outcome of {@link planClaudeAccountWrite}. */
export type ClaudeAccountWritePlan =
  | {
      ok: true;
      /**
       * The `accounts` value to validate with the rest of the config: the listed
       * rows, merged with the patch. A patched value that is not an array is
       * passed through for the schema to refuse.
       */
      accounts: unknown;
      /** Stored rows the read rules skip, carried to disk exactly as stored. */
      unlisted: unknown[];
    }
  | { ok: false; details: string[] };

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Why an id a write introduces is refused, or `null` when it is fine.
 *
 * Only a NEW row, or a row whose id CHANGED, is checked. An existing row keeps
 * whatever id it has, so a hand-edited id that predates the rule never blocks
 * an unrelated settings write; such a row simply has no usage file.
 */
function idRefusal(id: unknown): string | null {
  // An absent id is minted by the schema's own rule, which only produces good ids.
  if (id === undefined) return null;
  if (typeof id !== 'string' || !ACCOUNT_ID_PATTERN.test(id)) {
    return 'an account id must be lowercase letters and digits, in words joined by single hyphens';
  }
  if (id === IMPLICIT_ACCOUNT_ID) {
    return 'the id "default" is reserved for the default account';
  }
  return null;
}

/** Outcome of {@link takeAccountsSeen}. */
export type AccountsSeenTake =
  | {
      ok: true;
      /** The patch without `runtimes.claudeCode.accountsSeen`; the caller's object is untouched. */
      patch: Record<string, unknown>;
      /** The account ids the writer was shown, or `undefined` when it did not say. */
      seen: ReadonlySet<string> | undefined;
    }
  | { ok: false; details: string[] };

/**
 * Take `runtimes.claudeCode.accountsSeen` out of a config patch
 * (`ClaudeAccountsSeenSchema`). It is not a setting, so it must never reach the
 * merge, and it is validated here so a malformed list is refused rather than
 * read as "saw nothing".
 *
 * @param patch - The patch as the caller sent it.
 * @returns The patch without the key, and the ids it carried.
 */
export function takeAccountsSeen(patch: Record<string, unknown>): AccountsSeenTake {
  const runtimes = patch.runtimes;
  if (!isRecord(runtimes)) return { ok: true, patch, seen: undefined };
  const claudeCode = runtimes.claudeCode;
  if (!isRecord(claudeCode) || !(CLAUDE_ACCOUNTS_SEEN_KEY in claudeCode)) {
    return { ok: true, patch, seen: undefined };
  }
  const { [CLAUDE_ACCOUNTS_SEEN_KEY]: raw, ...rest } = claudeCode;
  const parsed = ClaudeAccountsSeenSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      details: [`runtimes.claudeCode.${CLAUDE_ACCOUNTS_SEEN_KEY}: must be a list of account ids.`],
    };
  }
  return {
    ok: true,
    patch: { ...patch, runtimes: { ...runtimes, claudeCode: rest } },
    seen: new Set(parsed.data),
  };
}

/**
 * A stored row with a label that is not text read as unnamed, so the schema,
 * which wants every field stated, does not refuse a write over a hand edit.
 */
function withReadableLabel(row: Record<string, unknown>): Record<string, unknown> {
  return typeof row.label === 'string' || row.label === null ? row : { ...row, label: null };
}

/**
 * Decide what a config write stores for the Claude account registry.
 *
 * - **Listed rows** (what `GET /api/config` shows) are the ones a patch can
 *   see, so they are the ones it edits. Each patched row is merged onto the
 *   stored row with the same id, or, when its id changed, the stored row with
 *   the same path. A field the patch sets wins, `color: null` included; a field
 *   it leaves out survives.
 * - **Removal is only of what the writer saw.** A stored listed row the patch
 *   leaves out is removed only when its id is in `seen` (the writer's
 *   `accountsSeen`): the writer was shown it and dropped it. Any other row,
 *   such as one flow added after the settings screen loaded, is kept after the
 *   patched rows. Without `seen` (the CLI's `dorkos config set`, the
 *   `config_patch` tool), every listed row counts as seen: the patch is a full
 *   replace of the listed rows, which is how those writers remove an account.
 *   Settings always sends `seen`.
 * - **Unlisted rows** (skipped by the read rules: not an object, no absolute
 *   path, or a later duplicate of an id) are kept exactly as stored and
 *   appended after the listed ones, which keeps a duplicate behind the row it
 *   duplicates. The client never saw them, so leaving one out cannot mean
 *   "remove it".
 * - **Ids.** A new row, or a row whose id changed, must use an id matching
 *   `ACCOUNT_ID_PATTERN` that is not `default`, else the write is refused
 *   naming the row. An unchanged id is never refused.
 *
 * A patch that does not name `accounts` gets the stored listed rows back, so the
 * whole-config validation never trips over a hand edit it cannot fix.
 *
 * @param stored - The stored `runtimes.claudeCode.accounts`, as read from disk.
 * @param patched - The patch's `accounts` value; `undefined` when the patch does not name it.
 * @param seen - The account ids the writer was shown (`accountsSeen`), if it said.
 * @returns The rows to validate and the rows to carry, or the refusal details.
 */
export function planClaudeAccountWrite(
  stored: unknown,
  patched: unknown,
  seen?: ReadonlySet<string>
): ClaudeAccountWritePlan {
  const { rows } = classifyClaudeAccountRows(stored);
  const storedArray = Array.isArray(stored) ? stored : [];
  const listed = rows.filter((view) => view.listed && view.row) as {
    index: number;
    row: Record<string, unknown>;
  }[];
  const unlisted = rows.filter((view) => !view.listed).map((view) => storedArray[view.index]);

  if (patched === undefined) {
    return { ok: true, accounts: listed.map(({ row }) => withReadableLabel(row)), unlisted };
  }
  // Not an array: nothing to merge, and the schema says what is wrong with it.
  if (!Array.isArray(patched)) return { ok: true, accounts: patched, unlisted };

  const claimed = new Set<number>();
  const details: string[] = [];
  const merged = patched.map((entry, index) => {
    if (!isRecord(entry)) return entry;
    const free = listed.filter((view) => !claimed.has(view.index));
    const match =
      free.find((view) => view.row.id === entry.id) ??
      (typeof entry.path === 'string'
        ? free.find((view) => view.row.path === entry.path)
        : undefined);
    if (match) claimed.add(match.index);
    if (!match || match.row.id !== entry.id) {
      const refusal = idRefusal(entry.id);
      if (refusal) {
        details.push(
          `runtimes.claudeCode.accounts.${index}.id: ${JSON.stringify(entry.id)} is refused: ${refusal}.`
        );
      }
    }
    return match ? { ...match.row, ...entry } : entry;
  });

  if (details.length > 0) return { ok: false, details };
  const kept = listed
    // No `seen` means the writer claims the whole list: every listed row counts as seen.
    .filter(
      (view) => !claimed.has(view.index) && seen !== undefined && !seen.has(view.row.id as string)
    )
    .map(({ row }) => withReadableLabel(row));
  return { ok: true, accounts: [...merged, ...kept], unlisted };
}
