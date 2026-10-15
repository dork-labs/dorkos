/**
 * Claude Code account registry: project roots, account rows, the id and rename heals, and the tolerant read.
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
});

/** One known Claude Code account. See {@link ClaudeCodeAccountSchema}. */
export type ClaudeCodeAccount = z.infer<typeof ClaudeCodeAccountSchema>;
/**
 * The registered Claude accounts, healing a registry written before ids existed.
 *
 * ## Why the heal is here rather than only in the migration
 *
 * `id` is REQUIRED, and it did not exist before 0.65.0 — so every config file
 * on every machine is missing it until the `'0.65.0'` migration runs. That
 * migration is skipped more often than it sounds: `conf` runs a key only when
 * `key > storedVersion && key <= projectVersion`, so a dev tree (`SERVER_VERSION`
 * resolves to `0.0.0`) runs NO migrations at all, and cutting a release below
 * `0.65.0` would skip it for every user on it.
 *
 * A missing REQUIRED field is not the same hazard as a leftover key, and this is
 * the distinction that makes this function necessary. `tolerateUnknownKeys`
 * (`config/version-skew.ts`) reopens objects, so an extra key is already
 * survivable; nothing reopens a `required` list. Left alone, an un-migrated
 * config fails Zod in `applyConfigPatch` — which parses the whole MERGED config
 * — so every settings write in the cockpit is refused until the migration runs.
 * Ajv is widened separately, in `config-manager.ts`, because
 * `z.toJSONSchema` emits a pipe's OUTPUT schema and would never see this.
 *
 * The heal is the migration's rule, not a second one: {@link claudeAccountId},
 * uniquified against the ids the registry already carries, so an id minted here
 * and an id the migration wrote agree. Rows keep their order and every other
 * field untouched.
 *
 * @param value - The stored `accounts` value, whatever shape it is in.
 * @returns The same rows with any missing id filled in.
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
 * Read `activeAccount` as `defaultAccount` on a config the `'0.65.0'` migration
 * has not reached (spec `billing-account-ladder`).
 *
 * The rename half of the same hazard {@link backfillMissingAccountIds} covers,
 * and the more expensive half, because what is at stake is not a derived id but
 * a choice the operator made about **who gets billed**. Left unhealed, a stored
 * `activeAccount` is invisible: `defaultAccount` reads `null`, the cockpit
 * reports "inherited", and new sessions run on whatever `$CLAUDE_CONFIG_DIR` the
 * launching shell exported — a different paying client's subscription, silently.
 *
 * It also has to happen BEFORE anything writes. `applyConfigPatch` re-parses and
 * persists the whole config, so without this a single unrelated settings change
 * lands `defaultAccount: null` on disk beside the old key — and the migration,
 * finding the new key present, would then keep the `null` and destroy the choice
 * permanently. Healing here means that write persists the right value instead.
 *
 * ## What this cannot see, and who covers it
 *
 * `null` and absent are treated alike here, and that is a deliberate limitation
 * rather than a full answer. `null` IS the absence of a choice under the new
 * name — but it is ALSO exactly how the cockpit spells "go back to inheriting".
 * This function is handed a stored block with no idea which of the two it is
 * looking at, so on its own it would read a deliberate clear as "nothing chosen
 * yet" and resurrect the old account the person just dismissed.
 *
 * Intent is known one layer up, where the incoming patch is still in hand:
 * `applyConfigPatch` calls {@link settleLegacyAccountAlias} first, which removes
 * the legacy key whenever the patch NAMES `defaultAccount`. By the time this
 * runs there is nothing left to resurrect, so a clear clears. Neither half works
 * alone — this one silently undoes clears, and that one only sees writes.
 *
 * A `defaultAccount` holding an actual path is a decision made since the rename
 * and wins over the old key regardless.
 *
 * ## The legacy key is dropped from the OUTPUT
 *
 * A contract of this function, so its answer carries one spelling for any
 * caller. Be precise about what that does and does not buy: parsing through
 * {@link ClaudeCodeSettingsSchema} would strip an undeclared key anyway, so
 * dropping it here changes nothing an end-to-end test can see. It is
 * defense-in-depth and legibility, not the mechanism.
 *
 * The mechanism that actually settles the FILE is a schema declaration, made in
 * `config-manager.ts`: `preserveUnknownKeys` re-attaches every key the schema
 * does not declare after each write, so while `activeAccount` was undeclared it
 * came back forever — including after the write that cleared the account.
 *
 * With all of it in place, a write that names `runtimes` persists a settled
 * block. A write naming some OTHER section — a theme change — still rewrites the
 * stored object as it stands, legacy key included, because `applyConfigPatch`
 * only persists the sections a patch names. That file converges when the
 * migration reaches it, or on the next write that touches `runtimes`, whichever
 * comes first.
 *
 * @param value - The stored `runtimes.claudeCode` block, whatever shape it is in.
 * @returns The block with `defaultAccount` carrying the choice and the legacy
 *   key gone.
 */
export function healClaudeAccountRename(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const block = value as Record<string, unknown>;
  if (!('activeAccount' in block)) return value;
  const { activeAccount: legacy, ...rest } = block;
  // A real value under the new name is a decision made since the rename; `null`
  // or absent means nobody has decided under it, so the old key still speaks.
  const healed =
    rest.defaultAccount == null && typeof legacy === 'string' && legacy.length > 0
      ? legacy
      : (rest.defaultAccount ?? null);
  return { ...rest, defaultAccount: healed };
}

/**
 * Take the legacy account key out of a merged config when the incoming patch
 * NAMED the new one — so an explicit clear is not read as "never set".
 *
 * The piece {@link healClaudeAccountRename} cannot supply. The heal sees a
 * stored block; only the write path still holds the patch, and the patch is the
 * only place the difference between "this person chose the default" and "nobody
 * has chosen yet" exists. Both spellings of that difference arrive as `null`.
 *
 * Applies whenever `runtimes.claudeCode.defaultAccount` is present in the patch
 * at all, whatever its value. Clearing to `null` is the case that was broken;
 * naming a different account is the same act and must not leave the superseded
 * spelling on disk either.
 *
 * Mutates `merged` in place — it is a fresh deep-merge result owned by the
 * caller, never the stored config.
 *
 * @param merged - The patch already deep-merged onto the current config.
 * @param patch - The patch as the caller received it.
 */
export function settleLegacyAccountAlias(merged: unknown, patch: unknown): void {
  const named = (patch as { runtimes?: { claudeCode?: Record<string, unknown> } } | null)?.runtimes
    ?.claudeCode;
  if (!named || typeof named !== 'object' || !('defaultAccount' in named)) return;
  const block = (merged as { runtimes?: { claudeCode?: Record<string, unknown> } } | null)?.runtimes
    ?.claudeCode;
  if (block && typeof block === 'object') delete block.activeAccount;
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
 * The Claude account settings as every READER should see them, healed.
 *
 * The launch ladder, the `GET /api/config` block and the root-set scan all read
 * `runtimes.claudeCode` straight off the `conf` store — raw stored JSON, never a
 * Zod parse — so none of them would otherwise see either heal. That is the
 * difference between a schema that is correct and a product that is: an id
 * healed only on parse leaves the ladder's top two rungs inert on every
 * un-migrated install, because a hint is matched by an id no stored row has.
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
 * Read-time only, by design. Nothing here writes: the migration remains the sole
 * writer of the settled shape, and a reader that heals cannot corrupt a file it
 * never touches. Nothing here logs either (this module is pure): the caller logs
 * `warnings`.
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
  const healed = healClaudeAccountRename(raw);
  const block =
    healed && typeof healed === 'object' ? (healed as Record<string, unknown>) : undefined;
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
