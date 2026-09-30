/**
 * The only writers of the account rules (spec `flow-multiproject` §8.1, §8.6):
 * a project's allow list, an account's `onlyProjects`, and the rename that
 * carries an account id through every allow list.
 *
 * **Never a dotted key path.** `projectAccounts` is keyed by absolute project
 * roots, and roots contain dots (`/Users/x/client.app`), which `conf` would
 * split into nested keys. Every write here reads the whole stored `runtimes`
 * section, changes one entry of `runtimes.claudeCode`, and writes the section
 * back, as `planClaudeAccountWrite` does for accounts. A registry row is edited
 * by id with every other field kept, so a field a newer flow wrote survives.
 *
 * Only a person reaches these: the two `PUT /api/runtimes/claude-code/...`
 * routes sit behind the person bar, and no extension `ctx` member calls them
 * (invariant 9).
 *
 * @module services/core/usage/account-eligibility-writes
 */
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { UserConfig } from '@dorkos/shared/config-schema';

/** Reads and writes the `runtimes` section (the config manager, or a test double). */
export interface RuntimesStore {
  get(key: 'runtimes'): unknown;
  set(key: 'runtimes', value: UserConfig['runtimes']): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the stored section and its `claudeCode` block, raw. */
function readBlock(store: RuntimesStore): {
  runtimes: Record<string, unknown>;
  block: Record<string, unknown>;
} {
  const runtimes = store.get('runtimes');
  const section = isRecord(runtimes) ? runtimes : {};
  const block = isRecord(section.claudeCode) ? section.claudeCode : {};
  return { runtimes: section, block };
}

function writeBlock(
  store: RuntimesStore,
  runtimes: Record<string, unknown>,
  block: Record<string, unknown>
): void {
  store.set('runtimes', { ...runtimes, claudeCode: block } as unknown as UserConfig['runtimes']);
}

/**
 * Set or remove one project's allow list.
 *
 * @param store - The config.
 * @param root - The canonical project root.
 * @param allow - The account ids that may work there, or null to remove the rule.
 */
export function writeProjectAccounts(
  store: RuntimesStore,
  root: string,
  allow: readonly string[] | null
): void {
  const { runtimes, block } = readBlock(store);
  const current = isRecord(block.projectAccounts) ? block.projectAccounts : {};
  const next: Record<string, unknown> = { ...current };
  if (allow === null) delete next[root];
  else next[root] = { allow: [...new Set(allow)] };
  writeBlock(store, runtimes, { ...block, projectAccounts: next });
}

/**
 * Set an account's own rule: the projects it may work in, or null for any.
 * `default` writes Main's rule (`defaultAccountOnlyProjects`).
 *
 * @param store - The config.
 * @param accountId - A registry id, or `default`.
 * @param roots - Canonical project roots, or null for any project.
 * @returns False when `accountId` names no registry row (and is not `default`).
 */
export function writeOnlyProjects(
  store: RuntimesStore,
  accountId: string,
  roots: readonly string[] | null
): boolean {
  const { runtimes, block } = readBlock(store);
  const value = roots === null ? null : [...new Set(roots)];
  if (accountId === IMPLICIT_ACCOUNT_ID) {
    writeBlock(store, runtimes, { ...block, defaultAccountOnlyProjects: value });
    return true;
  }
  const rows = Array.isArray(block.accounts) ? block.accounts : [];
  let found = false;
  const next = rows.map((row: unknown) => {
    if (found || !isRecord(row) || row.id !== accountId) return row;
    found = true;
    return { ...row, onlyProjects: value };
  });
  if (!found) return false;
  writeBlock(store, runtimes, { ...block, accounts: next });
  return true;
}

/**
 * Carry a renamed account id through every project's allow list, so a project
 * that allowed the account still allows it by its new id. Writes only when an
 * allow list named the old id. Idempotent.
 *
 * @param store - The config.
 * @param from - The old id.
 * @param to - The new id.
 */
export function renameAccountInProjectAccounts(
  store: RuntimesStore,
  from: string,
  to: string
): void {
  const { runtimes, block } = readBlock(store);
  if (!isRecord(block.projectAccounts)) return;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [root, rule] of Object.entries(block.projectAccounts)) {
    if (!isRecord(rule) || !Array.isArray(rule.allow) || !rule.allow.includes(from)) {
      next[root] = rule;
      continue;
    }
    changed = true;
    next[root] = {
      ...rule,
      allow: [...new Set(rule.allow.map((id: unknown) => (id === from ? to : id)))],
    };
  }
  if (changed) writeBlock(store, runtimes, { ...block, projectAccounts: next });
}
