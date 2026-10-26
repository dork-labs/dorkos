/**
 * Keep the model's own file-reading tools off the files that hold secrets
 * (DOR-3299, part 1).
 *
 * DorkOS auto-allows Claude Code's read-only tools with no path check
 * (`tool-gate/auto-allow.ts`), which overrides the CLI's own "ask before
 * reading outside the working folder". So at Ask first and Act, the model's
 * `Read` could open DorkOS's master key, the encrypted store, a Claude
 * sign-in, or the person's SSH keys and tokens, with no card. Deny rules are
 * checked before any allow and before `canUseTool`, at every permission level
 * Bypass included, so these hold everywhere a launch goes.
 *
 * Only the model's tools are stopped: `gh`, `git` and Claude Code itself still
 * read their own files. A read-only SHELL command (`grep -r`, `head`, `sed -n`)
 * is not a `Read` and is not covered here; that is part 2 (DOR-3300).
 *
 * The rules also name `Grep` and `Glob`, for a Claude Code that has those tools;
 * the bundled CLI has neither, and searches through the shell instead (part 2).
 * `*` in a rule crosses folders, so a file is named exactly and a folder ends
 * in `/**`.
 *
 * @module services/runtimes/claude-code/secret-files/secret-read-deny
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { DirectoryGrantError } from '@dorkos/shared/directory-grants';
import { rulePath } from '../messaging/directory-grants.js';

/** The file-reading tools a secret-read rule names. */
const READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** DorkOS's own secrets, relative to its data folder. A trailing `/**` is a folder. */
export const DATA_FOLDER_SECRETS = [
  'host.key',
  // The config (cloud and tunnel tokens among it), its backups beside it
  // (`config.json.bak`, `config-<time>.json.bak`), and full database and
  // settings snapshots.
  'config.json*',
  'config-*.json.bak',
  'backups/**',
  'mcp-local-token',
  'better-auth-secret',
  // The key the CLI calls this server with.
  'api-key',
  // The database: sign-in sessions and connected-app tokens, with its -wal/-shm,
  // under its current and its old name (`dorkos.db`).
  'dork*.db*',
  // Chat bot tokens, stored as written (`relay/adapter-config.ts`).
  'relay/adapters.json',
  // The web-push private key.
  'push/**',
  'extension-secrets/**',
  // Secrets moved out of agent folders (DOR-3292).
  'secrets/**',
  // The agent browser's signed-in state, and its profiles' cookies.
  'browser/storage-state.json',
  'browser/profile/**',
  'browser-profiles/**',
  'local-browser/saved-logins/**',
] as const;

/** The sign-in files inside every Claude Code account folder, backups included. */
export const ACCOUNT_FOLDER_SECRETS = ['.credentials*', '.claude.json*', 'backups/**'] as const;

/**
 * Sign-ins named wherever they sit, since `*` crosses folders: any Claude
 * account (an odd or added-later folder too), and the Codex and OpenCode
 * sign-ins in their default and moved homes.
 */
export const ANYWHERE_SECRETS = [
  '//**/.credentials*',
  '//**/.claude.json*',
  '//**/.codex/auth.json',
  '//**/opencode/auth.json',
] as const;

/**
 * The person's own keys and tokens, in the home-folder spelling Claude Code
 * expands itself. Only well-known spots that hold a credential.
 */
export const HOME_SECRETS = [
  '.ssh/**',
  '.aws/**',
  '.config/gh/hosts.yml',
  '.netrc',
  '.npmrc',
  '.docker/config.json',
  '.config/gcloud/**',
  // The default account's sign-in, whatever account this launch uses.
  '.claude.json*',
  '.claude/.credentials*',
  '.claude/backups/**',
  // The default data folder's secrets, whatever data folder this launch uses.
  ...DATA_FOLDER_SECRETS.map((entry) => `.dork/${entry}`),
] as const;

/** Where this launch's secrets live. */
export interface SecretFolders {
  /** DorkOS's data folder. */
  dorkHome: string;
  /** The launch's own Claude Code account folder. */
  accountRoot: string;
  /** Every other account folder DorkOS knows of. */
  otherAccountRoots: readonly string[];
}

/** A path and, when it differs, the real place it points to. */
function spellingsOf(folder: string): string[] {
  const resolved = path.resolve(folder);
  try {
    const real = realpathSync.native(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

/**
 * The deny rules that keep `Read`, `Grep` and `Glob` off every secret file.
 *
 * @param folders - Where this launch's secrets live.
 * @throws DirectoryGrantError when a folder's path can't be named exactly in a
 *   rule — failing closed, as the person-only data deny does.
 */
export function secretReadDenyRules(folders: SecretFolders): string[] {
  const targets: string[] = [...ANYWHERE_SECRETS];
  const named = (folder: string, entries: readonly string[], required: boolean): void => {
    for (const spelling of spellingsOf(folder)) {
      const root = rulePath(spelling);
      if (root !== undefined) {
        for (const entry of entries) targets.push(`${root}/${entry}`);
        continue;
      }
      // Another account's odd name stops nothing: the rules above still name
      // its sign-in files wherever they sit. This launch's own folders must be
      // named exactly, or the turn doesn't start.
      if (!required) continue;
      throw new DirectoryGrantError(
        `Claude Code can't keep the secrets in "${folder}" away from agents, because its ` +
          `name has a character its safety rules can't match: a question mark, a backslash, a ` +
          `hidden control character, or a space at the very end. So this turn was not started. ` +
          `Move that folder to a path without those characters, then try again.`
      );
    }
  };
  named(folders.dorkHome, DATA_FOLDER_SECRETS, true);
  named(folders.accountRoot, ACCOUNT_FOLDER_SECRETS, true);
  for (const account of folders.otherAccountRoots) named(account, ACCOUNT_FOLDER_SECRETS, false);
  for (const entry of HOME_SECRETS) targets.push(`~/${entry}`);
  const rules = targets.flatMap((target) => READ_TOOLS.map((tool) => `${tool}(${target})`));
  return [...new Set(rules)];
}

/** The slice of Claude Code settings this module writes. */
interface DenySettings {
  deny?: string[];
  [key: string]: unknown;
}

/**
 * Merge {@link secretReadDenyRules} into the launch's `settings.permissions.deny`,
 * keeping everything else the launch carries.
 *
 * @param sdkOptions - The launch options, mutated in place.
 * @param folders - Where this launch's secrets live.
 */
export function applySecretReadDeny(sdkOptions: Options, folders: SecretFolders): void {
  const rules = secretReadDenyRules(folders);
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = ((base as { permissions?: DenySettings }).permissions ?? {}) as DenySettings;
  const deny = [...(permissions.deny ?? [])];
  for (const rule of rules) if (!deny.includes(rule)) deny.push(rule);
  sdkOptions.settings = {
    ...base,
    permissions: { ...permissions, deny },
  } as Options['settings'];
}
