/**
 * Claude Code account registry: project roots, account rows, shared id rules and tolerant reads.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/claude-accounts
 */
import { z } from 'zod';
import {
  ACCOUNT_COLOR_PATTERN,
  ACCOUNT_ID_PATTERN,
  isAbsoluteAccountPath,
  isAccountColor,
  isReservedAccountId,
  resolveAccountColor,
} from '../account-identity.js';
import { claudeAccountId } from '../config-schema.js';

/**
 * A list of project roots: absolute, canonical paths of git main checkouts
 * (spec `flow-multiproject` §8.1). Roots contain dots (`/Users/x/client.app`),
 * so a writer never addresses one through a dotted config key path; it reads
 * the whole `runtimes.claudeCode` block, changes it and writes it back.
 */
const ProjectRootListSchema = z.array(z.string().min(1));

/**
 * A stored project-root rule, read tolerantly: a hand edit of the wrong shape
 * (`"client-app"`, a number) reads as `null`, "any project", and blank or
 * non-string entries are dropped, so a bad edit never makes the config
 * unloadable (`readProjectRootList`, the reader every launch uses, agrees).
 */
export const TolerantProjectRootListSchema = z.preprocess(
  (raw) => readProjectRootList(raw),
  ProjectRootListSchema.nullable()
);

/**
 * One project's rule for which Claude accounts may work in it
 * (`runtimes.claudeCode.projectAccounts[root]`, spec `flow-multiproject` §8.1).
 * `allow` lists account ids, `default` (Main) included. A project with no entry
 * allows every account its own rule allows.
 */
export const ProjectAccountsRuleSchema = z.object({
  /** The account ids that may work in this project. */
  allow: z.array(z.string().min(1)),
});

/** One project's account rule. See {@link ProjectAccountsRuleSchema}. */
export type ProjectAccountsRule = z.infer<typeof ProjectAccountsRuleSchema>;

/**
 * `runtimes.claudeCode.projectAccounts`, read tolerantly: an entry without an
 * `allow` list reads as no rule (dropped), blank or non-string ids in a list
 * are dropped, and a value that is not an object reads as `{}`. The reader
 * every launch uses (`readEligibilityRules`) applies the same rules, so a hand
 * edit never makes the config unloadable and never means two things.
 */
export const TolerantProjectAccountsSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, { allow: string[] }> = {};
    for (const [root, rule] of Object.entries(raw as Record<string, unknown>)) {
      if (root.length === 0 || !rule || typeof rule !== 'object') continue;
      const allow = (rule as { allow?: unknown }).allow;
      if (!Array.isArray(allow)) continue;
      out[root] = {
        allow: allow.filter((id): id is string => typeof id === 'string' && id.length > 0),
      };
    }
    return out;
  },
  z.record(z.string().min(1), ProjectAccountsRuleSchema)
);

/**
 * One Claude Code account DorkOS knows about — a Claude config directory holding
 * its own `projects/` transcripts and its own sign-in
 * (`runtimes.claudeCode.accounts`, spec `claude-code-accounts` D1).
 *
 * The **path is what runs**: it is literally what `CLAUDE_CONFIG_DIR` takes. The
 * label exists because the operator's real question is _which client_ a session
 * belongs to, and `~/.claude2` does not answer that while "Acme Corp" does.
 *
 * The **id is what everything else references** (ADR 260821-205324). An agent
 * manifest and a session launch hint name an account by id, never by path, so a
 * directory the operator moves or renames stays one edit in one
 * operator-controlled place instead of silently breaking every agent pointing at
 * it. An id that is no longer registered degrades to the next tier of the launch
 * ladder rather than failing a launch.
 *
 * **A row keeps fields it does not know**, but not through this schema. The
 * registry is a shared contract with flow (marketplace `specs/flow-cli-core`
 * §1.1a: "readers ignore fields they do not know; writers preserve them"), and
 * a parse strips them. The object stays closed on purpose: the config
 * disclosure and write-policy guards classify every leaf of the schema and
 * refuse an open catchall, which a loose object would put on every row. So the
 * one writer that parses rows, `applyConfigPatch`, carries each row's unknown
 * fields across itself (`planClaudeAccountWrite`), and every reader reads the
 * stored row, not a parse of it.
 */
export const ClaudeCodeAccountSchema = z.object({
  /**
   * Stable kebab-case slug for this account, unique within the registry. What
   * agents and launch hints reference. Generated at registration from the label
   * (else the path's basename) — see {@link claudeAccountId}.
   */
  id: z.string().min(1),
  /** Absolute path of the Claude config directory this account lives in. */
  path: z.string().min(1),
  /** What the operator calls this account; `null` when they have not named it. */
  label: z.string().nullable(),
  /**
   * The color DorkOS draws this account's dot and badge in, as lowercase
   * `#rrggbb`. `null` means the default for the account's position in the
   * registry (resolved at read time, never stored), so an absent or `null`
   * color follows the palette if it changes. A value that is not lowercase
   * `#rrggbb` reads as `null` rather than failing the whole config.
   */
  color: z.string().regex(ACCOUNT_COLOR_PATTERN).nullable().default(null).catch(null),
  /**
   * The projects this account may work in, as canonical project roots (git
   * main checkouts), or `null` for any project (spec `flow-multiproject` §8,
   * N6). A list never includes "no project": an account kept to client-app
   * does not run in a folder that is in no repository. Written only by a
   * person, through `PUT /api/runtimes/claude-code/accounts/:id/only-projects`.
   *
   * Optional rather than defaulted, and absent reads exactly as `null`: a row
   * is a shared contract with flow (readers ignore fields they do not know,
   * writers keep them), so rows written by an older flow or by hand carry no
   * such field, and every reader (`readProjectRootList`) treats that as "any
   * project". The `'0.93.0'` migration still writes `null` onto stored rows.
   */
  onlyProjects: TolerantProjectRootListSchema.optional(),
  /**
   * `true` when a person said never to move agents to this account on their
   * own: a room seat whose account runs out skips it, though a person may
   * still move a seat to it by naming it. Absent or `false` means it may be
   * picked, which is how every account behaved before the flag existed.
   *
   * Optional rather than defaulted, for the reason `onlyProjects` is: rows are
   * shared with flow and written by hand, so most carry no such field. A
   * value that is not a boolean reads as absent rather than failing the
   * config. The `'0.124.1'` migration sets it on one account.
   */
  noAutoMove: z.boolean().optional().catch(undefined),
});

/** One known Claude Code account. See {@link ClaudeCodeAccountSchema}. */
export type ClaudeCodeAccount = z.infer<typeof ClaudeCodeAccountSchema>;
/**
 * Mint missing ids under the current shared Flow account-row contract (§1.1a).
 *
 * Rows may be written by Flow or by hand. Reserve every existing id first,
 * including later rows, then use the same minting rule in parsing and reading.
 * This is current registry behavior, not an old-config conversion.
 *
 * @param value - The stored accounts value, of any shape.
 * @returns The rows with missing ids filled in; other fields stay unchanged.
 */
function backfillMissingAccountIds(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  // Every id already present is reserved BEFORE any is minted — including ids
  // belonging to rows later in the list. Seeding this as we go would let a
  // backfilled row claim an id a subsequent row already owns.
  const taken = new Set<string>();
  for (const row of value) {
    if (row && typeof row === 'object') {
      const id = (row as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) taken.add(id);
    }
  }
  return value.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const account = row as Record<string, unknown>;
    if (typeof account.id === 'string' && account.id.length > 0) return account;
    const id = claudeAccountId({
      label: typeof account.label === 'string' ? account.label : null,
      path: typeof account.path === 'string' ? account.path : '',
      taken,
    });
    taken.add(id);
    return { ...account, id };
  });
}

/**
 * Why a registry row was read differently from how it is stored (contract
 * §1.1a). Each is logged once by the reader's caller.
 *
 * - `row-invalid`: the entry is not an object; skipped.
 * - `path-invalid`: `path` is missing or not absolute; skipped.
 * - `id-duplicate`: an earlier listed row already has this id; skipped.
 * - `id-reserved`: the id is `default`, which names the default account, or
 *   `dorkos-credits`, which names DorkOS credits;
 *   listed, but not routable until the config migration renames it.
 * - `id-invalid`: the id fails {@link ACCOUNT_ID_PATTERN} (a hand edit);
 *   listed, but it has no usage file and cannot be routed.
 * - `color-invalid`: `color` is not lowercase `#rrggbb`; read as `null`.
 * - `label-invalid`: `label` is set but not text; read as `null`.
 * - `id-minted`: a listed row had no id; read with the one minted for it.
 * - `accounts-invalid`: `accounts` is set but not a list; read as no rows.
 *   It names no row, so its `index` is `-1`.
 */
export type ClaudeAccountReadWarningCode =
  | 'row-invalid'
  | 'path-invalid'
  | 'id-duplicate'
  | 'id-reserved'
  | 'id-invalid'
  | 'color-invalid'
  | 'label-invalid'
  | 'id-minted'
  | 'accounts-invalid';

/** One thing the registry reader noticed about a stored row. */
export interface ClaudeAccountReadWarning {
  /** What was wrong. */
  code: ClaudeAccountReadWarningCode;
  /** The row's position in the STORED array, or `-1` for `accounts-invalid`. */
  index: number;
  /** One line naming the row and what the reader did about it. */
  message: string;
}

/** One stored registry row as the read rules classify it. */
export interface ClaudeAccountRowView {
  /** The row's position in the stored array. */
  index: number;
  /** The stored row with a minted id filled in when it had none; `null` when not an object. */
  row: Record<string, unknown> | null;
  /** True when the read rules list this row (it can be seen and edited). */
  listed: boolean;
}

/**
 * Apply the contract's read rules (§1.1a) to a stored `accounts` value, in the
 * contract's order.
 *
 * 1. Mint a missing id on EVERY object row, in array order, with every id
 *    already present reserved first (`backfillMissingAccountIds`). Minting
 *    happens before anything is skipped, because skipping first would shift
 *    later ids and flow and DorkOS would write different ledger files.
 * 2. Skip a row that is not an object, or whose `path` is missing or not
 *    absolute.
 * 3. Of two remaining rows sharing an id, keep the first.
 *
 * The single classification both the reader and the write path use, so a row
 * the settings screen was never shown is exactly a row the write path keeps.
 *
 * @param value - The stored `runtimes.claudeCode.accounts` value, any shape.
 * @param noun - What a warning calls one row, starting with a capital: `Claude account`
 *   (the default), `Codex account` or `OpenCode account`.
 * @returns Every stored row with its verdict, and the warnings for the skipped ones.
 */
export function classifyClaudeAccountRows(
  value: unknown,
  noun = 'Claude account'
): {
  rows: ClaudeAccountRowView[];
  warnings: ClaudeAccountReadWarning[];
} {
  const minted = backfillMissingAccountIds(value);
  if (!Array.isArray(minted)) return { rows: [], warnings: [] };
  const warnings: ClaudeAccountReadWarning[] = [];
  const seen = new Set<string>();
  const rows = minted.map((entry, index): ClaudeAccountRowView => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push({
        code: 'row-invalid',
        index,
        message: `${noun} ${index + 1} is not an object, so it was skipped.`,
      });
      return { index, row: null, listed: false };
    }
    const row = entry as Record<string, unknown>;
    const id = row.id as string;
    if (!isAbsoluteAccountPath(row.path)) {
      warnings.push({
        code: 'path-invalid',
        index,
        message: `${noun} "${id}" has no absolute path, so it was skipped.`,
      });
      return { index, row, listed: false };
    }
    if (seen.has(id)) {
      warnings.push({
        code: 'id-duplicate',
        index,
        message: `${noun} "${id}" repeats an earlier account's id, so it was skipped.`,
      });
      return { index, row, listed: false };
    }
    seen.add(id);
    return { index, row, listed: true };
  });
  return { rows, warnings };
}

/** One registry row as a READER sees it, with its display color resolved. */
export type ReadClaudeAccount = ClaudeCodeAccount & {
  /** The color to draw it in: the stored color, else the default for its position. */
  color: string;
  /** True when {@link ReadClaudeAccount.color} is the positional default, not a stored choice. */
  colorIsDefault: boolean;
  /**
   * The id this row had before the `'0.87.0'` migration renamed it (only ever
   * `default`), until the account reconcile has moved every reference to it.
   */
  renamedFrom?: string;
  /** Any other field the stored row carries, kept as stored. */
  [field: string]: unknown;
};

/**
 * A stored project-root list as a reader sees it: the non-empty strings of an
 * array, or `null` (any project) for anything that is not an array. A reader
 * never fails over a hand-edited rule; the launch path reads raw JSON.
 *
 * @param raw - A stored `onlyProjects` or `defaultAccountOnlyProjects` value.
 * @returns The roots, or `null` for "any project".
 */
export function readProjectRootList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((root): root is string => typeof root === 'string' && root.length > 0);
}

/**
 * Read the current Claude account settings without interpreting retired aliases.
 *
 * The registry follows the contract's read rules (§1.1a, see
 * {@link classifyClaudeAccountRows}): ids minted over every row first, then a
 * row with no absolute path skipped, then the first of two rows sharing an id
 * kept. A listed row whose id is `default` or fails {@link ACCOUNT_ID_PATTERN}
 * stays listed with a warning; a bad `color` reads as `null`. Each row's color
 * is resolved by its position among the LISTED rows, so a skipped hand edit
 * never shifts the colors the operator sees. A missing or non-string `label`
 * reads as `null`. The warning codes are the contract's (`identity.cases` in
 * flow's conformance fixture), so a minted id, a label that is not text and an
 * `accounts` that is not a list are each reported too.
 *
 * Read-time only: nothing here writes or logs. The caller logs `warnings`.
 * Config startup refuses the retired default-account spelling before any write.
 *
 * @param raw - The stored `runtimes.claudeCode` block, or anything at all. Codex's
 *   and OpenCode's blocks read by the same rules.
 * @param noun - What a warning calls one row, starting with a capital: `Claude account`
 *   (the default), `Codex account` or `OpenCode account`.
 * @returns The default account, the listed registry, and what the reader noticed.
 */
export function readClaudeAccountSettings(
  raw: unknown,
  noun = 'Claude account'
): {
  defaultAccount: string | null;
  accounts: ReadClaudeAccount[];
  warnings: ClaudeAccountReadWarning[];
} {
  const block = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const defaultAccount = typeof block?.defaultAccount === 'string' ? block.defaultAccount : null;
  const storedRows = block?.accounts;
  const { rows, warnings } = classifyClaudeAccountRows(storedRows, noun);
  if (storedRows !== undefined && storedRows !== null && !Array.isArray(storedRows)) {
    warnings.push({
      code: 'accounts-invalid',
      index: -1,
      message: `The ${noun} list is not a list, so it was read as no accounts.`,
    });
  }
  const accounts: ReadClaudeAccount[] = [];
  for (const { index, row, listed } of rows) {
    if (!listed || !row) continue;
    const id = row.id as string;
    const storedId = (storedRows as Record<string, unknown>[])[index]?.id;
    if (typeof storedId !== 'string' || storedId.length === 0) {
      warnings.push({
        code: 'id-minted',
        index,
        message: `${noun} ${index + 1} has no id, so it was read as "${id}".`,
      });
    }
    if (row.label !== undefined && row.label !== null && typeof row.label !== 'string') {
      warnings.push({
        code: 'label-invalid',
        index,
        message: `${noun} "${id}" has a label that is not text, so it has no label.`,
      });
    }
    if (isReservedAccountId(id)) {
      warnings.push({
        code: 'id-reserved',
        index,
        message: `${noun} "${id}" uses the reserved id "${id}", so it is listed but not routable until it is renamed.`,
      });
    } else if (!ACCOUNT_ID_PATTERN.test(id)) {
      warnings.push({
        code: 'id-invalid',
        index,
        message: `${noun} "${id}" has an id that is not lowercase words joined by hyphens, so it is listed but not routable.`,
      });
    }
    const stored = row.color;
    if (stored !== undefined && stored !== null && !isAccountColor(stored)) {
      warnings.push({
        code: 'color-invalid',
        index,
        message: `${noun} "${id}" has a color that is not lowercase #rrggbb, so it uses the default.`,
      });
    }
    const colorIsDefault = !isAccountColor(stored);
    accounts.push({
      ...row,
      id,
      path: row.path as string,
      label: typeof row.label === 'string' ? row.label : null,
      color: resolveAccountColor(colorIsDefault ? null : (stored as string), accounts.length),
      colorIsDefault,
      // Absent (a row written before the rule existed, or by an older flow)
      // reads as `null`, any project: today's behaviour.
      onlyProjects: readProjectRootList(row.onlyProjects),
      // Only a stored `true` keeps an account out of automatic moves; a row
      // without the field stays without it.
      ...('noAutoMove' in row ? { noAutoMove: row.noAutoMove === true } : {}),
    });
  }
  return { defaultAccount, accounts, warnings };
}

/**
 * The agent runtimes configured on this host, in a fixed order.
 *
 * claude-code is always available; codex and opencode are included unless they
 * are explicitly turned off, since both default to enabled. The one definition
 * behind the config DTO's `runtimes` list and the feedback report's, so the web
 * app and a pasted report can never disagree about what a host runs.
 *
 * Takes a dotted-path reader rather than a parsed config, because both callers
 * hold one (`configManager.getDot`, the feedback gatherer's `readConfigValue`)
 * and a store that is missing or unreadable should degrade to the defaults
 * instead of failing.
 *
 * @param read - Reads one dotted config path; returns `undefined` when unset.
 * @returns The configured runtime ids, `claude-code` first.
 */
export function configuredRuntimes(read: (key: string) => unknown): string[] {
  const runtimes = ['claude-code'];
  if (read('runtimes.codex.enabled') !== false) runtimes.push('codex');
  if (read('runtimes.opencode.enabled') !== false) runtimes.push('opencode');
  if (read('runtimes.doe.enabled') !== false) runtimes.push('doe');
  return runtimes;
}

/**
 * The Claude account registry: rows with stable ids, no two the same.
 *
 * Uniqueness is enforced rather than assumed because an id is a REFERENCE — an
 * agent manifest and a session launch hint name an account by it, and the
 * resolver takes the first match. Two rows sharing an id would make one of them
 * unreachable and silently bill every agent naming it to the other one's
 * subscription. {@link backfillMissingAccountIds} can never produce a collision;
 * a hand-edited file or a buggy client can, and this is where they are told.
 */
export const ClaudeCodeAccountsSchema = z.preprocess(
  backfillMissingAccountIds,
  z.array(ClaudeCodeAccountSchema).superRefine((accounts, ctx) => {
    const seen = new Set<string>();
    accounts.forEach((account, index) => {
      if (!seen.has(account.id)) {
        seen.add(account.id);
        return;
      }
      ctx.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: `Duplicate Claude account id "${account.id}" — an id is how an agent or a session names one account, so it has to name exactly one.`,
      });
    });
  })
);

/**
 * The ids of the Claude accounts a writer was SHOWN, sent beside
 * `runtimes.claudeCode.accounts` in a config PATCH as
 * `runtimes.claudeCode.accountsSeen` (spec `claude-account-fleet` D1).
 *
 * Not a setting: the write path takes it out of the patch before merging, and
 * nothing stores it. It exists because a PATCH replaces the account array, and
 * flow can add an account while the settings screen is open. Without it, a row
 * the screen never saw would read as one the operator removed. With it, the
 * server removes only a stored row whose id is in this list and that the patch
 * left out; every other stored row is kept. A patch naming `accounts` without
 * this list is a full replace of the listed rows, as before (the CLI's
 * `dorkos config set` and the `config_patch` tool); rows the read rules skip
 * are kept either way.
 */
export const ClaudeAccountsSeenSchema = z.array(z.string());

/** The patch key {@link ClaudeAccountsSeenSchema} travels under, inside `runtimes.claudeCode`. */
export const CLAUDE_ACCOUNTS_SEEN_KEY = 'accountsSeen';
