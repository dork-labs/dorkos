/**
 * Which accounts may work in which projects (spec `flow-multiproject` §8, N6):
 * the rule every place that picks an account asks, and the one plain refusal
 * they all give.
 *
 * Two rules, and an account works in a project only when **both** allow it:
 *
 * - **The account's own rule.** A registry row's `onlyProjects` (Main's is
 *   `runtimes.claudeCode.defaultAccountOnlyProjects`, since Main has no row).
 *   `null` allows any project. A list allows only those project roots, and
 *   never "no project": a work account kept to client-app does not run in a
 *   folder that is in no repository.
 * - **The project's rule.** `runtimes.claudeCode.projectAccounts[root].allow`.
 *   A project with no entry allows every account; an entry allows exactly the
 *   ids it lists. "No project" has no project rule.
 *
 * A project is a git main checkout, always found through the project registry
 * ({@link projectOfFolder}), so a worktree, a subfolder and a symlinked path of
 * one repository are one project. An empty or unknown folder (several callers
 * pass `''`) is "no project", which a restricted account never serves.
 *
 * `default` is judged by Main's own rule. Where a caller holds a folder rather
 * than an id (the launch ladder), it names the account by its folder first, so
 * a registry row that has Main's folder is judged by that row's rule.
 *
 * Runtime-keyed on purpose: only Claude Code has a multi-account registry
 * today, so every other runtime's accounts are always eligible, and a second
 * runtime is a data change here rather than a new code path.
 *
 * @module services/core/usage/account-eligibility
 */
import path from 'node:path';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { readProjectRootList } from '@dorkos/shared/config-schema';
import { ACCOUNT_NOT_ALLOWED_CODE, type ProjectRef } from '@dorkos/shared/project-schemas';

import { projectRegistry, sanitizeNameSegment } from '../../projects/project-registry.js';

/** The runtimes that have account rules. */
export type EligibilityRuntime = 'claude-code';

/** Why an account may not work in a project. */
export type Ineligible =
  /** The account's own rule keeps it to other projects. */
  | { reason: 'only-projects'; allowedProjects: ProjectRef[] }
  /** The project's rule does not list the account. */
  | { reason: 'project-allowlist'; project: ProjectRef };

/** The answer to {@link accountEligibility}. */
export type EligibilityVerdict = { eligible: true } | ({ eligible: false } & Ineligible);

/** Reads the config the rules live in (`configManager`, or a test double). */
export interface EligibilityConfigReader {
  get(key: 'runtimes'): unknown;
}

/** The two rules, read once and compared canonically. */
export interface EligibilityRules {
  /** Each registry row's `onlyProjects`, canonical, by id (`null` = any project). */
  onlyProjectsById: ReadonlyMap<string, readonly string[] | null>;
  /** Main's rule (`defaultAccountOnlyProjects`), canonical. */
  defaultOnlyProjects: readonly string[] | null;
  /** Each project's allow list, keyed by canonical root. */
  projectAllow: ReadonlyMap<string, readonly string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalList(
  roots: readonly string[] | null,
  canonical: (dir: string) => string
): string[] | null {
  return roots === null ? null : [...new Set(roots.map(canonical))];
}

/**
 * Read the rules from a stored `runtimes.claudeCode` block. Pure apart from the
 * injectable canonical-path step. Absence is the default everywhere (any
 * project, no project rules), because the launch path reads raw JSON that a
 * migration may not have reached; a hand-edited value that is not the right
 * shape reads as absent rather than failing a launch.
 *
 * @param claudeCode - The stored `runtimes.claudeCode` block, or anything.
 * @param realCanonical - The canonical spelling of a folder (real path).
 */
export function readEligibilityRules(
  claudeCode: unknown,
  realCanonical: (dir: string) => string = canonicalDirectory
): EligibilityRules {
  // One real-path lookup per distinct root for this read, however many rules
  // name it: every check re-reads the config, so this runs on every launch.
  const seen = new Map<string, string>();
  const canonical = (dir: string): string => {
    let known = seen.get(dir);
    if (known === undefined) {
      known = realCanonical(dir);
      seen.set(dir, known);
    }
    return known;
  };
  const block = isRecord(claudeCode) ? claudeCode : {};
  const onlyProjectsById = new Map<string, readonly string[] | null>();
  const rows = Array.isArray(block.accounts) ? block.accounts : [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || onlyProjectsById.has(row.id)) continue;
    onlyProjectsById.set(row.id, canonicalList(readProjectRootList(row.onlyProjects), canonical));
  }
  const projectAllow = new Map<string, readonly string[]>();
  if (isRecord(block.projectAccounts)) {
    for (const [root, rule] of Object.entries(block.projectAccounts)) {
      if (!isRecord(rule) || !Array.isArray(rule.allow)) continue;
      const allow = rule.allow.filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      );
      projectAllow.set(canonical(root), allow);
    }
  }
  return {
    onlyProjectsById,
    defaultOnlyProjects: canonicalList(
      readProjectRootList(block.defaultAccountOnlyProjects),
      canonical
    ),
    projectAllow,
  };
}

/** The pure verdict, on canonical roots: what the rules say, with no names attached. */
export type RootVerdict =
  | { eligible: true }
  | { eligible: false; reason: 'only-projects'; allowedRoots: readonly string[] }
  | { eligible: false; reason: 'project-allowlist' };

/**
 * Judge one account against both rules. Pure.
 *
 * @param rules - From {@link readEligibilityRules}.
 * @param accountId - A registry id, or `default` for Main.
 * @param projectRoot - The canonical project root, or null for no project.
 */
export function judgeEligibility(
  rules: EligibilityRules,
  accountId: string,
  projectRoot: string | null
): RootVerdict {
  const own =
    accountId === IMPLICIT_ACCOUNT_ID
      ? rules.defaultOnlyProjects
      : (rules.onlyProjectsById.get(accountId) ?? null);
  if (own !== null && (projectRoot === null || !own.includes(projectRoot))) {
    return { eligible: false, reason: 'only-projects', allowedRoots: own };
  }
  if (projectRoot !== null) {
    const allow = rules.projectAllow.get(projectRoot);
    if (allow !== undefined && !allow.includes(accountId)) {
      return { eligible: false, reason: 'project-allowlist' };
    }
  }
  return { eligible: true };
}

/**
 * The project a root is, named as the registry names it: the known name, else
 * the folder's name in the characters a project name may hold.
 *
 * @param root - A project root, canonical.
 */
export function projectRefFor(root: string): ProjectRef {
  const known = projectRegistry.get(root);
  return known
    ? { root: known.root, name: known.name }
    : { root, name: sanitizeNameSegment(path.basename(root)) || 'project' };
}

function readRules(config: EligibilityConfigReader): EligibilityRules {
  let block: unknown;
  try {
    block = (config.get('runtimes') as { claudeCode?: unknown } | undefined)?.claudeCode;
  } catch {
    // An unreadable config has no rules, exactly as an empty one: the launch
    // path degrades rather than failing over a settings read.
    block = undefined;
  }
  return readEligibilityRules(block);
}

/**
 * Whether an account may serve work in a project.
 *
 * @param config - Where the rules live.
 * @param runtime - The account's runtime; runtimes without rules always allow.
 * @param accountId - A registry id, or `default` for Main.
 * @param project - The project, or null for a folder in no project.
 */
export function accountEligibility(
  config: EligibilityConfigReader,
  runtime: string,
  accountId: string,
  project: ProjectRef | null
): EligibilityVerdict {
  if (runtime !== 'claude-code') return { eligible: true };
  const verdict = judgeEligibility(readRules(config), accountId, project?.root ?? null);
  if (verdict.eligible) return verdict;
  if (verdict.reason === 'only-projects') {
    return {
      eligible: false,
      reason: 'only-projects',
      allowedProjects: verdict.allowedRoots.map(projectRefFor),
    };
  }
  return { eligible: false, reason: 'project-allowlist', project: project as ProjectRef };
}

/**
 * The eligible subset of `accountIds`, order kept.
 *
 * @param config - Where the rules live.
 * @param runtime - The accounts' runtime.
 * @param accountIds - Registry ids, `default` included.
 * @param project - The project, or null for no project.
 */
export function eligibleAccountIds(
  config: EligibilityConfigReader,
  runtime: string,
  accountIds: readonly string[],
  project: ProjectRef | null
): string[] {
  if (runtime !== 'claude-code') return [...accountIds];
  const rules = readRules(config);
  const root = project?.root ?? null;
  return accountIds.filter((id) => judgeEligibility(rules, id, root).eligible);
}

/**
 * The projects an account is kept to, named, or null for any project. For
 * Settings and the eligibility route.
 *
 * @param config - Where the rules live.
 * @param accountId - A registry id, or `default` for Main.
 */
export function onlyProjectsOf(
  config: EligibilityConfigReader,
  accountId: string
): ProjectRef[] | null {
  const rules = readRules(config);
  const own =
    accountId === IMPLICIT_ACCOUNT_ID
      ? rules.defaultOnlyProjects
      : (rules.onlyProjectsById.get(accountId) ?? null);
  return own === null ? null : own.map(projectRefFor);
}

/**
 * The project a folder belongs to, through the server's one project registry.
 * An empty, missing or unresolvable folder is "no project"; it never throws.
 *
 * @param cwd - Any folder, or nothing.
 */
export async function projectOfFolder(cwd: string | null | undefined): Promise<ProjectRef | null> {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  try {
    return await projectRegistry.resolve(cwd);
  } catch {
    return null;
  }
}

/**
 * What every surface says for an account kept to no project at all (an empty
 * `onlyProjects`): the Settings row, the pickers and the refusal sentence.
 */
export const NOT_USED_IN_ANY_PROJECT = 'Not used in any project';

/** Names joined for a sentence: `a`, `a and b`, `a, b and c`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Nothing may work here: the third kind of refusal. */
export interface NoneEligible {
  reason: 'none-eligible';
}

/** What an account refusal says, and about what. */
export type AccountRefusalDetail = Ineligible | NoneEligible;

/**
 * The account rules in a stored `runtimes.claudeCode` block that are NOT the
 * shape a writer would store, and so read as "no rule" (a hand edit): Main's
 * rule, each row's `onlyProjects`, and each `projectAccounts` entry. Pure.
 *
 * @param claudeCode - The stored `runtimes.claudeCode` block, or anything.
 * @returns The dot-paths of the malformed rules, empty when all are well formed.
 */
export function malformedAccountRules(claudeCode: unknown): string[] {
  if (!isRecord(claudeCode)) return [];
  const out: string[] = [];
  const isRootList = (value: unknown) =>
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.every((root) => typeof root === 'string' && root.length > 0));
  if (!isRootList(claudeCode.defaultAccountOnlyProjects)) {
    out.push('runtimes.claudeCode.defaultAccountOnlyProjects');
  }
  if (Array.isArray(claudeCode.accounts)) {
    claudeCode.accounts.forEach((row, index) => {
      if (isRecord(row) && !isRootList(row.onlyProjects)) {
        out.push(`runtimes.claudeCode.accounts.${index}.onlyProjects`);
      }
    });
  }
  const projectAccounts = claudeCode.projectAccounts;
  if (projectAccounts !== undefined && !isRecord(projectAccounts)) {
    out.push('runtimes.claudeCode.projectAccounts');
  } else if (isRecord(projectAccounts)) {
    for (const [root, rule] of Object.entries(projectAccounts)) {
      const allow = isRecord(rule) ? rule.allow : undefined;
      const ok =
        Array.isArray(allow) && allow.every((id) => typeof id === 'string' && id.length > 0);
      if (!ok) out.push(`runtimes.claudeCode.projectAccounts[${JSON.stringify(root)}]`);
    }
  }
  return out;
}

/**
 * Say once, at boot, which hand-edited account rules are malformed and so read
 * as "no rule": the loader keeps the file rather than refusing it, and a
 * person who meant a rule must be able to find out it is not in force.
 *
 * @param config - Where the rules live.
 * @param warn - Where the warning goes (the logger; tests pass a spy).
 * @returns The malformed paths it warned about.
 */
export function warnMalformedAccountRules(
  config: EligibilityConfigReader,
  warn: (message: string, meta: Record<string, unknown>) => void
): string[] {
  let block: unknown;
  try {
    block = (config.get('runtimes') as { claudeCode?: unknown } | undefined)?.claudeCode;
  } catch {
    return [];
  }
  const paths = malformedAccountRules(block);
  if (paths.length > 0) {
    warn(
      '[accounts] Some account rules in config.json are not in the right shape, so DorkOS reads them as no rule (any project, every account). Set them again in Settings → Runtimes.',
      { paths }
    );
  }
  return paths;
}

/**
 * The plain sentence for a refusal (spec `flow-multiproject` §8.3).
 *
 * @param project - The project the work was for, or null.
 * @param accountName - What the person calls the account (null with none-eligible).
 * @param detail - Why.
 */
export function describeAccountRefusal(
  project: ProjectRef | null,
  accountName: string | null,
  detail: AccountRefusalDetail
): string {
  const account = accountName ?? 'This account';
  if (detail.reason === 'none-eligible') {
    return project
      ? `No account is allowed to work in ${project.name}. Choose which accounts it may use in Settings → Runtimes.`
      : "No account is allowed to work in this folder, because it isn't in a project and every account is set to work only in certain projects. Change this in Settings → Runtimes.";
  }
  if (detail.reason === 'project-allowlist') {
    return `${detail.project.name} isn't set to use ${account}. Pick another account, or remove ${detail.project.name}'s account limit in Settings → Runtimes.`;
  }
  const allowed = joinNames(detail.allowedProjects.map((p) => p.name));
  // One wording for an account kept to no project at all, everywhere it shows.
  if (!allowed) {
    return `${account} is ${NOT_USED_IN_ANY_PROJECT.toLowerCase()}. Pick another account, or change this in Settings → Runtimes.`;
  }
  if (!project) {
    return `${account} is set to work only in ${allowed}, and this folder isn't in a project. Pick another account.`;
  }
  return `${account} can't be used in ${project.name}. It's set to work only in ${allowed}. Pick another account, or change this in Settings → Runtimes.`;
}

/**
 * What a person calls a Claude account: its label, else its id; Main for
 * `default`.
 *
 * @param config - Where the registry lives.
 * @param accountId - A registry id, or `default`.
 */
export function accountDisplayName(config: EligibilityConfigReader, accountId: string): string {
  if (accountId === IMPLICIT_ACCOUNT_ID) return 'Main';
  try {
    const block = (config.get('runtimes') as { claudeCode?: unknown } | undefined)?.claudeCode;
    const rows = isRecord(block) && Array.isArray(block.accounts) ? block.accounts : [];
    const row = rows.find((r) => isRecord(r) && r.id === accountId) as
      Record<string, unknown> | undefined;
    if (row && typeof row.label === 'string' && row.label.length > 0) return row.label;
  } catch {
    // Fall back to the id.
  }
  return accountId;
}

/**
 * A launch refused because the account may not work in the project, with the
 * sentence to show (spec `flow-multiproject` §8.3). Routes answer `409` with
 * {@link AccountNotAllowedError.toBody}.
 */
export class AccountNotAllowedError extends Error {
  /** The machine-readable code every surface uses. */
  readonly code = ACCOUNT_NOT_ALLOWED_CODE;
  /** The HTTP status a route answers. */
  readonly status = 409 as const;

  /**
   * Build a refusal.
   *
   * @param project - The project the work was for, or null for no project.
   * @param accountId - The account refused, or null when none was eligible.
   * @param detail - Why.
   * @param message - The sentence; built from the rest when omitted.
   */
  constructor(
    readonly project: ProjectRef | null,
    readonly accountId: string | null,
    readonly detail: AccountRefusalDetail,
    message?: string
  ) {
    super(message ?? describeAccountRefusal(project, accountId, detail));
    this.name = 'AccountNotAllowedError';
  }

  /** The `409` body: `{ error, message, code, project, accountId }`. */
  toBody(): {
    error: string;
    message: string;
    code: typeof ACCOUNT_NOT_ALLOWED_CODE;
    project: ProjectRef | null;
    accountId: string | null;
  } {
    return {
      error: this.message,
      message: this.message,
      code: this.code,
      project: this.project,
      accountId: this.accountId,
    };
  }
}

/**
 * The refusal for one ineligible account, with the account named as the person
 * calls it.
 *
 * @param config - Where the registry lives.
 * @param accountId - The refused account.
 * @param project - The project, or null.
 * @param verdict - The ineligible verdict.
 */
export function refusalFor(
  config: EligibilityConfigReader,
  accountId: string,
  project: ProjectRef | null,
  verdict: { eligible: false } & Ineligible
): AccountNotAllowedError {
  const { eligible: _eligible, ...detail } = verdict;
  return new AccountNotAllowedError(
    project,
    accountId,
    detail,
    describeAccountRefusal(project, accountDisplayName(config, accountId), detail)
  );
}

/**
 * Refuse an ineligible account, or do nothing.
 *
 * @param config - Where the rules live.
 * @param runtime - The account's runtime.
 * @param accountId - The account picked.
 * @param project - The project, or null.
 * @throws {AccountNotAllowedError} When the account may not work there.
 */
export function assertAccountEligible(
  config: EligibilityConfigReader,
  runtime: string,
  accountId: string,
  project: ProjectRef | null
): void {
  const verdict = accountEligibility(config, runtime, accountId, project);
  if (!verdict.eligible) throw refusalFor(config, accountId, project, verdict);
}
