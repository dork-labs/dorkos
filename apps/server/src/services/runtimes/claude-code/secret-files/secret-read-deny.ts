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
 * read their own files. The CLI also holds a shell command that NAMES a denied
 * file (`cat`, `head`, `sed -n`), but not a search of a whole folder
 * (`grep -r`, `rg -uu`); that is part 2 (DOR-3300).
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

/**
 * Files in the agent's own folder whose names say they hold a secret: the
 * secret-files scan's list (`core/secret-file-scan/scan-folder.ts`), at any
 * depth, wherever a rule can spell it (DOR-3292). Templates stay readable, so
 * `.env.*` is the usual names rather than a wildcard (`.env.example` is not a
 * secret), and an SSH key is named whole so its `.pub` half still reads.
 *
 * What this holds, on the bundled CLI at every level, Bypass included: the
 * `Read` tool, and a shell command that names the file (`cat .env`, a link
 * to it, `.ENV`). What it can't: a search of the whole folder (`grep -r`,
 * `rg -uu`) and any program that opens the file itself (`python3 -c`, which
 * Bypass runs). Only moving the file out of the folder stops those.
 */
export const AGENT_FOLDER_SECRETS = [
  '.env',
  '.env.local',
  '.env.*.local',
  '.env.development',
  '.env.dev',
  '.env.production',
  '.env.prod',
  '.env.staging',
  '.env.test',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.tfvars',
  '*.tfstate',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.envrc',
  '.dev.vars',
  '.git-credentials',
  '.pgpass',
  'application_default_credentials.json',
  'credentials',
  'credentials.json',
  '*service-account*.json',
  '.docker/config.json',
  '.kube/config',
].map((name) => `**/${name}`);

/** Where this launch's secrets live. */
export interface SecretFolders {
  /** DorkOS's data folder. */
  dorkHome: string;
  /** The launch's own Claude Code account folder. */
  accountRoot: string;
  /** Every other account folder DorkOS knows of. */
  otherAccountRoots: readonly string[];
  /** The agent's own folder and the turn's working folder, when known. */
  agentFolders?: readonly (string | null | undefined)[];
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
  // Not required: an agent folder with an odd name was never covered, and
  // refusing its turns would be new harm for no new hold.
  for (const agent of folders.agentFolders ?? []) {
    if (agent) named(agent, AGENT_FOLDER_SECRETS, false);
  }
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
