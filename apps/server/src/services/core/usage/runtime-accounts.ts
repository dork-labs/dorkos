/**
 * Which accounts each runtime has, and which one `default` names: DorkOS's
 * implementation of the shared account rules (marketplace `specs/flow-cli-core`
 * §1.1a, revision 6d, fixtures 3.0.0), mirroring flow's `resolveAccounts`.
 *
 * - **An account is its folder, not its id.** Two folders are one account when
 *   their comparable forms match ({@link canonicalAccountPath}).
 * - **`default` is machine-wide.** Claude Code's is `defaultAccount`, else the
 *   pre-0.65.0 `activeAccount`, else `<home>/.claude`; Codex's is
 *   `<home>/.codex`; OpenCode keeps a folder-less ambient default only while it
 *   has no registered row. It is resolved from CONFIG and the OS home only, never
 *   from a process's environment: a server started with `CLAUDE_CONFIG_DIR=/x`
 *   must not make `default` mean `/x`, or it would read, write and prune another
 *   account's ledger.
 * - **Alias or standalone.** When a routable registered row has the default
 *   folder, `default` is another name for that row (one ledger, one row).
 *   Otherwise `default` is an account of its own, listed after the registered
 *   rows, with the ledger `default.json`.
 *
 * Pure: no filesystem except the injectable real-path lookup, no clock, no
 * logging. The OS home is an input, because only the Hard Rule 3 carve-outs
 * (`claude-config-dir.ts`, `codex-home.ts`) may ask the OS for it.
 *
 * @module services/core/usage/runtime-accounts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ACCOUNT_ID_PATTERN,
  IMPLICIT_ACCOUNT_ID,
  LEDGER_RUNTIMES,
  resolveAccountColor,
  type LedgerRuntime,
} from '@dorkos/shared/account-usage';
import { claudeAccountId } from '@dorkos/shared/config-schema';

/** The label a standalone `default` account shows (contract §1.1a rev 6d, rule 4). */
export const DEFAULT_ACCOUNT_LABEL = "Main (this computer's sign-in)";

/** Where each runtime's registry lives under `config.json`'s `runtimes`. */
const RUNTIME_CONFIG_KEYS: Readonly<Record<LedgerRuntime, string>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
};

/** A warning the account rules raise, named as the contract's fixtures name them. */
export interface AccountWarning {
  /** What happened, e.g. `id-invalid`, `id-reserved`, `default-account-invalid`. */
  code: string;
  /** A sentence for the log. */
  message: string;
}

/** A real-path lookup: the folder's real path, or `null` when it does not exist. */
export type RealpathLookup = (dir: string) => string | null;

/** One account of one runtime, registered or the runtime's own `default`. */
export interface RuntimeAccount {
  /** The runtime it belongs to. */
  runtime: LedgerRuntime;
  /** The registry id, or `default` for the runtime's own account. */
  id: string;
  /** The folder it runs in, `~` expanded; `null` for OpenCode's ambient default. */
  path: string | null;
  /** Its folder in comparable form, or `null` with no folder. */
  canonicalPath: string | null;
  /** The operator's name for it, {@link DEFAULT_ACCOUNT_LABEL} for a standalone default. */
  label: string | null;
  /** The resolved display color (stored, else the default for its position). */
  color: string;
  /** False for a row whose id fails the pattern or is the reserved `default`. */
  routable: boolean;
  /** True for the runtime's own `default` (no registry row). */
  implicit: boolean;
  /** True when `<runtime>:default` names this account (the standalone default, or its alias). */
  isDefault: boolean;
  /** The ledger file's id (`<ledgerId>.json`), or `null` when it has no ledger. */
  ledgerId: string | null;
  /**
   * The id this row had before the `'0.87.0'` config migration renamed it (only
   * ever `default`), while the account reconcile has not yet moved the
   * references to it. Until then `default` still resolves to this row.
   */
  renamedFrom?: string;
}

/** Resolves the folder a runtime's `default` names (see {@link defaultAccountFolder}). */
export type DefaultFolderResolver = (
  runtime: LedgerRuntime,
  config: unknown
) => { path: string | null; warnings: AccountWarning[] };

/**
 * The inputs the rules resolve from besides `config.json`. No environment, on
 * purpose. Give `home` (the conformance fixtures do), or `defaultFolder` (the
 * server does, from the Hard Rule 3 carve-outs that may ask the OS for it).
 */
export interface AccountResolutionInputs {
  /** The parsed `config.json` (`null`/`undefined` when missing). */
  config: unknown;
  /** The OS home folder, for `~` and the built-in default folders. */
  home?: string;
  /** Resolves each runtime's default folder; wins over `home` when given. */
  defaultFolder?: DefaultFolderResolver;
  /** The real-path lookup. Default: the filesystem. */
  realpath?: RealpathLookup;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
  );
}

/** The filesystem's real path of `dir`, or `null` when it cannot be resolved. */
export function systemRealpath(dir: string): string | null {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return null;
  }
}

/**
 * `dir` with a leading `~` expanded (when `home` is known), resolved, trailing
 * separators dropped.
 *
 * @param dir - A folder as written.
 * @param home - The OS home folder; without it a `~` is left as written.
 */
export function expandAccountPath(dir: string, home?: string): string {
  let expanded = dir;
  if (home !== undefined) {
    if (expanded === '~') expanded = home;
    else if (expanded.startsWith('~/')) expanded = path.join(home, expanded.slice(2));
  }
  return path.resolve(expanded);
}

/**
 * A folder in the form two folders are compared in (contract §1.1a rev 6d,
 * rule 1): `~` expanded, resolved, then its real path when it exists (so a
 * symlink finds its target), else as normalized.
 *
 * @param dir - A folder as written in config or held by a session.
 * @param home - The OS home folder, for `~` (absolute folders need none).
 * @param realpath - The real-path lookup. Default: the filesystem.
 */
export function canonicalAccountPath(
  dir: string,
  home: string | undefined,
  realpath: RealpathLookup = systemRealpath
): string {
  const expanded = expandAccountPath(dir, home);
  return realpath(expanded) ?? expanded;
}

/**
 * The folder `<runtime>:default` names, machine-wide (contract rev 6d, rule 2),
 * from config and the OS home only:
 *
 * - Claude Code: `runtimes.claudeCode.defaultAccount` when it is a non-empty
 *   path (absolute, or starting with `~`); else `activeAccount` (its name
 *   before 0.65.0) when `defaultAccount` is null or absent; else
 *   `<home>/.claude`. Text that is not a path is ignored with
 *   `default-account-invalid`.
 * - Codex: `<home>/.codex`.
 * - OpenCode: `null` (its ambient default has no folder).
 *
 * @param runtime - The runtime.
 * @param config - The parsed `config.json`.
 * @param home - The OS home folder.
 * @returns The folder, `~` expanded and resolved, or `null`, and warnings.
 */
export function defaultAccountFolder(
  runtime: LedgerRuntime,
  config: unknown,
  home: string
): { path: string | null; warnings: AccountWarning[] } {
  const warnings: AccountWarning[] = [];
  if (runtime === 'opencode') return { path: null, warnings };
  if (runtime === 'claude-code') {
    const runtimes = isObject(config) ? config.runtimes : undefined;
    const section = isObject(runtimes) ? runtimes.claudeCode : undefined;
    let chosen: string | undefined;
    if (isObject(section)) {
      if (typeof section.defaultAccount === 'string' && section.defaultAccount !== '') {
        chosen = section.defaultAccount;
      } else if (
        section.defaultAccount == null &&
        typeof section.activeAccount === 'string' &&
        section.activeAccount !== ''
      ) {
        chosen = section.activeAccount;
      }
    }
    if (chosen !== undefined) {
      if (chosen === '~' || chosen.startsWith('~/') || isAbsolutePath(chosen)) {
        return { path: expandAccountPath(chosen, home), warnings };
      }
      warnings.push({
        code: 'default-account-invalid',
        message:
          'runtimes.claudeCode.defaultAccount is not an absolute path; used the built-in default folder instead.',
      });
    }
  }
  return {
    path: path.join(home, runtime === 'claude-code' ? '.claude' : '.codex'),
    warnings,
  };
}

/**
 * One runtime's registered rows (contract §1.1a read rules): ids minted over
 * every object row BEFORE any row is skipped (every present id reserved first,
 * and `default` always taken), rows without an absolute path skipped, the first
 * of two rows sharing an id kept, a pattern-failing or `default` id listed but
 * not routable, and a bad color read as the positional default.
 */
function readRegistered(
  runtime: LedgerRuntime,
  config: unknown,
  home: string | undefined,
  realpath: RealpathLookup
): { accounts: RuntimeAccount[]; warnings: AccountWarning[] } {
  const warnings: AccountWarning[] = [];
  const accounts: RuntimeAccount[] = [];
  const key = RUNTIME_CONFIG_KEYS[runtime];
  const runtimes = isObject(config) ? config.runtimes : undefined;
  const section = isObject(runtimes) ? runtimes[key] : undefined;
  const rows = isObject(section) ? section.accounts : undefined;
  if (!Array.isArray(rows)) return { accounts, warnings };

  const taken = new Set<string>([IMPLICIT_ACCOUNT_ID]);
  for (const row of rows) {
    if (isObject(row) && typeof row.id === 'string' && row.id.length > 0) taken.add(row.id);
  }
  const ids = rows.map((row) => {
    if (!isObject(row)) return null;
    if (typeof row.id === 'string' && row.id.length > 0) return row.id;
    const id = claudeAccountId({
      label: typeof row.label === 'string' ? row.label : null,
      path: typeof row.path === 'string' ? row.path : '',
      taken,
    });
    taken.add(id);
    return id;
  });

  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const id = ids[index];
    if (!isObject(row) || id === null || id === undefined) return;
    if (!isAbsolutePath(row.path)) {
      warnings.push({
        code: 'path-invalid',
        message: `runtimes.${key}.accounts[${index}] has no absolute path; skipped it.`,
      });
      return;
    }
    if (seen.has(id)) {
      warnings.push({
        code: 'id-duplicate',
        message: `Account id "${id}" appears more than once; kept the first row.`,
      });
      return;
    }
    seen.add(id);
    const reserved = id === IMPLICIT_ACCOUNT_ID;
    const routable = !reserved && ACCOUNT_ID_PATTERN.test(id);
    if (reserved) {
      warnings.push({
        code: 'id-reserved',
        message: 'Account id "default" is reserved; this row is listed with no usage file.',
      });
    } else if (!routable) {
      warnings.push({
        code: 'id-invalid',
        message: `Account id "${id}" is not lowercase letters, digits and single hyphens; it has no usage file.`,
      });
    }
    const expanded = expandAccountPath(row.path, home);
    accounts.push({
      runtime,
      id,
      path: expanded,
      canonicalPath: realpath(expanded) ?? expanded,
      label: typeof row.label === 'string' ? row.label : null,
      color: resolveAccountColor(typeof row.color === 'string' ? row.color : null, index),
      routable,
      implicit: false,
      isDefault: false,
      ledgerId: routable ? id : null,
      ...(typeof row.renamedFrom === 'string' ? { renamedFrom: row.renamedFrom } : {}),
    });
  });
  return { accounts, warnings };
}

/**
 * One runtime's accounts (contract rev 6d): registered rows in registry order,
 * then the runtime's own `default` when it stands alone. When a routable row
 * has the default folder, that row carries `isDefault` and no separate
 * `default` is listed.
 *
 * @param runtime - The runtime.
 * @param inputs - The parsed config, the OS home and the real-path lookup.
 */
export function resolveRuntimeAccounts(
  runtime: LedgerRuntime,
  inputs: AccountResolutionInputs
): { accounts: RuntimeAccount[]; warnings: AccountWarning[] } {
  const realpath = inputs.realpath ?? systemRealpath;
  const read = readRegistered(runtime, inputs.config, inputs.home, realpath);
  const warnings = [...read.warnings];
  const registered = read.accounts;
  const defaultColor = resolveAccountColor(null, registered.length);
  if (runtime === 'opencode') {
    if (registered.length > 0) return { accounts: registered, warnings };
    return { accounts: [implicitAccount(runtime, null, null, defaultColor)], warnings };
  }
  const chosen = resolveDefaultFolder(runtime, inputs);
  warnings.push(...chosen.warnings);
  if (chosen.path === null) return { accounts: registered, warnings };
  const folder = chosen.path;
  const canonical = realpath(folder) ?? folder;
  const alias = registered.find((a) => a.routable && a.canonicalPath === canonical);
  if (alias) {
    alias.isDefault = true;
    return { accounts: registered, warnings };
  }
  return {
    accounts: [...registered, implicitAccount(runtime, folder, canonical, defaultColor)],
    warnings,
  };
}

function resolveDefaultFolder(
  runtime: LedgerRuntime,
  inputs: AccountResolutionInputs
): { path: string | null; warnings: AccountWarning[] } {
  if (inputs.defaultFolder) return inputs.defaultFolder(runtime, inputs.config);
  if (inputs.home === undefined) {
    throw new Error('resolveRuntimeAccounts needs either `home` or `defaultFolder`.');
  }
  return defaultAccountFolder(runtime, inputs.config, inputs.home);
}

function implicitAccount(
  runtime: LedgerRuntime,
  folder: string | null,
  canonical: string | null,
  color: string
): RuntimeAccount {
  return {
    runtime,
    id: IMPLICIT_ACCOUNT_ID,
    path: folder,
    canonicalPath: canonical,
    label: folder === null ? null : DEFAULT_ACCOUNT_LABEL,
    color,
    routable: true,
    implicit: true,
    isDefault: true,
    ledgerId: IMPLICIT_ACCOUNT_ID,
  };
}

/**
 * The account an id names in one runtime: `default` resolves to whichever
 * account `isDefault` marks (its alias row, when it has one); any other id to
 * the registered row with that id.
 *
 * One transitional exception, the same one the launch ladder makes: while a
 * routable row still carries `renamedFrom: 'default'` (the `'0.87.0'` rename
 * whose references have not moved yet), `default` names that row, because the
 * references that say `default` meant it the day before the upgrade.
 *
 * @param accounts - Accounts from {@link resolveRuntimeAccounts}.
 * @param runtime - The runtime.
 * @param id - `default` or a registry id.
 */
export function resolveAccountRef(
  accounts: readonly RuntimeAccount[],
  runtime: LedgerRuntime,
  id: string
): RuntimeAccount | null {
  if (id === IMPLICIT_ACCOUNT_ID) {
    return (
      accounts.find((a) => a.runtime === runtime && a.routable && a.renamedFrom === id) ??
      accounts.find((a) => a.runtime === runtime && a.isDefault) ??
      null
    );
  }
  return accounts.find((a) => a.runtime === runtime && !a.implicit && a.id === id) ?? null;
}

/**
 * The routable account whose folder is `dir` (compared canonically): the
 * account a session running in that folder bills. First match wins.
 *
 * @param accounts - Accounts from {@link resolveRuntimeAccounts}.
 * @param runtime - The runtime.
 * @param dir - The folder the session runs in.
 * @param home - The OS home folder, for `~` (absolute folders need none).
 * @param realpath - The real-path lookup.
 */
export function accountForPath(
  accounts: readonly RuntimeAccount[],
  runtime: LedgerRuntime,
  dir: string,
  home: string | undefined,
  realpath: RealpathLookup = systemRealpath
): RuntimeAccount | null {
  const target = canonicalAccountPath(dir, home, realpath);
  return (
    accounts.find((a) => a.runtime === runtime && a.routable && a.canonicalPath === target) ?? null
  );
}

/**
 * Which ledger files to delete because their account is no longer registered
 * (contract §1.2 "Removing an account"; the `prune.cases` fixture). Per runtime,
 * every id on disk that is not a registered ledger id, in on-disk order.
 * `registered` holds each account's LEDGER id: a routable row's id, and
 * `default` only while `default` stands alone, so an aliased default's leftover
 * `default.json` goes and its row's file stays.
 *
 * Pure. Callers apply their own guards (such as a minimum file age) to the
 * result, never inside it.
 *
 * @param registered - Each runtime's ledger ids; a missing runtime reads as none.
 * @param onDisk - Each runtime's ids with a `<id>.json`; a missing runtime reads as none.
 */
export function pruneTargets(
  registered: Readonly<Partial<Record<LedgerRuntime, readonly string[]>>>,
  onDisk: Readonly<Partial<Record<LedgerRuntime, readonly string[]>>>
): Record<LedgerRuntime, string[]> {
  const out = {} as Record<LedgerRuntime, string[]>;
  for (const runtime of LEDGER_RUNTIMES) {
    const known = new Set(registered[runtime] ?? []);
    out[runtime] = (onDisk[runtime] ?? []).filter((id) => !known.has(id));
  }
  return out;
}
