/**
 * Find files in an agent's folder whose NAMES say they hold a secret
 * (DOR-3292). Names only: a file is never opened, read, logged or sent, so a
 * finding is a path and the rule it matched, never a value.
 *
 * Why it exists: no rule keeps an agent from reading a file inside its own
 * folder. Claude Code auto-allows read-only shell commands there (`rg -uu`
 * reads `.env` under a `Read(./.env)` deny), and Bypass reads anything. The
 * honest answer is to tell the person, so they can move the file out.
 *
 * Hidden and gitignored files are included, since that is where secrets live.
 * `node_modules` and `.git` are skipped. A symlink is reported when its NAME
 * matches (an agent can read through it), but a symlinked folder is never
 * entered, so the walk stays inside the folder.
 *
 * @module services/core/secret-file-scan/scan-folder
 */
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** One secret-looking file, by name. */
export interface SecretFileFinding {
  /** Absolute path. Never the contents. */
  path: string;
  /** The name rule it matched, e.g. `.env` or `*.pem`. */
  rule: string;
}

/** What one folder's scan found, and whether it stopped early. */
export interface SecretFolderScan {
  findings: SecretFileFinding[];
  /** True when the depth or entry limit cut the walk short. */
  truncated: boolean;
}

/** How deep and how wide one scan goes. */
export const SECRET_SCAN_LIMITS = { maxDepth: 6, maxEntries: 20_000 } as const;

/** Folders never entered: package installs and git internals. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);

/** Extensions that hold keys, certificates or infrastructure secrets. */
const SECRET_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.tfvars',
  '.tfstate',
];

/** Private SSH key names (their `.pub` halves are public). */
const SSH_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];

/** Whole names that hold a token or password. */
const SECRET_FILE_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.envrc',
  '.dev.vars',
  '.git-credentials',
  '.pgpass',
  'application_default_credentials.json',
]);

/** Names that are secrets only at a known spot. */
const SECRET_PATH_TAILS = ['.docker/config.json', '.kube/config'];

/** `.env.*` files that are templates, not secrets. */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample']);

/**
 * The name rule a file matches, or `undefined`. The list is the ticket's,
 * kept narrow on purpose: a warning that fires on everything gets ignored.
 *
 * @param name - The file's own name.
 * @param relPath - Its path from the scanned folder, `/`-separated.
 */
export function secretNameRule(name: string, relPath: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === '.env') return '.env';
  if (lower.startsWith('.env.') && !ENV_TEMPLATES.has(lower)) return '.env.*';
  for (const ext of SECRET_EXTENSIONS) if (lower.endsWith(ext)) return `*${ext}`;
  // A public key is not a secret.
  if (!lower.endsWith('.pub')) {
    for (const key of SSH_KEY_PREFIXES) if (lower.startsWith(key)) return `${key}*`;
  }
  if (SECRET_FILE_NAMES.has(lower)) return lower;
  if (lower === 'credentials' || lower === 'credentials.json') return lower;
  if (lower.endsWith('.json') && lower.includes('service-account')) return '*service-account*.json';
  for (const tail of SECRET_PATH_TAILS) {
    if (relPath === tail || relPath.endsWith(`/${tail}`)) return tail;
  }
  return undefined;
}

/**
 * Walk one folder for secret-looking names. Never throws: an unreadable
 * folder contributes nothing.
 *
 * @param root - The folder to scan.
 * @param limits - Depth and entry caps.
 */
export async function scanFolderForSecretNames(
  root: string,
  limits: { maxDepth: number; maxEntries: number } = SECRET_SCAN_LIMITS
): Promise<SecretFolderScan> {
  const findings: SecretFileFinding[] = [];
  let seen = 0;
  let truncated = false;
  const queue: { dir: string; rel: string; depth: number }[] = [
    { dir: path.resolve(root), rel: '', depth: 0 },
  ];
  while (queue.length > 0) {
    const { dir, rel, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > limits.maxEntries) return { findings, truncated: true };
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_FOLDERS.has(entry.name)) continue;
        if (depth + 1 > limits.maxDepth) {
          truncated = true;
          continue;
        }
        queue.push({ dir: full, rel: relPath, depth: depth + 1 });
        continue;
      }
      // A file, or a symlink (never followed): judged by its name alone.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const rule = secretNameRule(entry.name, relPath);
      if (rule) findings.push({ path: full, rule });
    }
  }
  return { findings, truncated };
}
