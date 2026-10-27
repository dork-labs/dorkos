/**
 * The power a worktree's `.claude/settings.local.json` would add (DOR-3298).
 *
 * The file is gitignored, so nobody reviews it, and an agent with a shell can
 * write one: a `PreToolUse` hook that answers "allow" is a self-grant that runs
 * on the next turn. So the parts of it that run code or widen what runs are
 * digested, and a launch loads the file only once a person approved exactly
 * that content:
 *
 * - the keys that run code, sign in or pick MCP servers
 *   ({@link CODE_SETTINGS_KEYS}, the same list the agent-home pin uses);
 * - `permissions.allow`, `permissions.additionalDirectories` and
 *   `permissions.defaultMode`;
 * - the bytes of every script those commands name inside the folder.
 *
 * A file with none of them has nothing to approve. Everything else in it is
 * preference and loads as usual once approved; until then the whole file is
 * left out (the launch drops the `local` settings source), so nothing in it
 * can run. Unlike the repo's committed settings there is no default branch to
 * compare against: this is content approval only.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-local-settings
 */
import path from 'node:path';
import {
  canonicalJson,
  CODE_SETTINGS_KEYS,
  collectCommands,
} from '../folder-settings/folder-config-pin.js';
import { namedTargets } from '../folder-settings/folder-config-scripts.js';
import { pickKeys, readScript, readSettingsFile, sha256 } from './repo-files.js';

/** The `permissions` keys that widen what runs. */
const PERMISSION_KEYS = ['allow', 'additionalDirectories', 'defaultMode'] as const;

/**
 * The parts of a parsed settings file that run code or widen what runs: the
 * {@link CODE_SETTINGS_KEYS}, and `permissions.allow`, `additionalDirectories`
 * and `defaultMode` under `permissions`. `null` when it sets none of them.
 *
 * @param value - The parsed settings file.
 */
export function pickPowerSettings(value: unknown): Record<string, unknown> | null {
  const picked: Record<string, unknown> = { ...(pickKeys(value, CODE_SETTINGS_KEYS) ?? {}) };
  const permissions = (value as { permissions?: unknown } | null)?.permissions;
  const pickedPermissions =
    permissions === undefined ? null : pickKeys(permissions, PERMISSION_KEYS);
  if (pickedPermissions) picked.permissions = pickedPermissions;
  return Object.keys(picked).length > 0 ? picked : null;
}

/** What a worktree's local settings would add. */
export interface LocalSettingsReading {
  /** The content digest a person approves. */
  digest: string;
  /** The keys that make it need approval, by name only (`hooks`, `permissions.allow`). */
  keys: string[];
  /** The approvable content, pretty, for the card. */
  detail: string;
  /** False when a file can't be read: never approved, never asked about. */
  approvable: boolean;
}

/**
 * Read `<cwd>/.claude/settings.local.json`. `null` when it is absent or adds
 * nothing that runs code.
 *
 * @param cwd - The folder the turn launches in.
 * @param dorkHome - DorkOS's data folder, whose `plugins/` scripts are not the folder's.
 */
export function readLocalSettings(cwd: string, dorkHome: string): LocalSettingsReading | null {
  const read = readSettingsFile(path.join(cwd, '.claude', 'settings.local.json'));
  if (read.kind === 'absent') return null;
  if (read.kind === 'unverifiable') {
    return { digest: 'unverifiable', keys: ['settings.local.json'], detail: '', approvable: false };
  }
  if (read.kind === 'malformed') {
    // Claude Code skips a file it can't parse; it is still content a person
    // approves, so a later edit that makes it parse asks again.
    return {
      digest: sha256(canonicalJson({ malformed: sha256(read.text) })),
      keys: ['settings.local.json'],
      detail: read.text,
      approvable: true,
    };
  }
  const picked = pickPowerSettings(read.value);
  if (!picked) return null;
  const pickedPermissions = (picked.permissions ?? null) as Record<string, unknown> | null;

  const commands: string[] = [];
  collectCommands(picked, commands);
  const root = path.resolve(cwd);
  const scripts: [string, string][] = [];
  let approvable = true;
  for (const target of namedTargets(root, path.resolve(dorkHome, 'plugins'), commands)) {
    if (!target.startsWith(`${root}${path.sep}`)) continue;
    const script = readScript(target);
    const rel = path.relative(root, target).split(path.sep).join('/');
    if (script.kind === 'unverifiable') approvable = false;
    scripts.push([
      rel,
      script.kind === 'file'
        ? sha256(script.bytes)
        : script.kind === 'absent'
          ? 'absent'
          : script.kind,
    ]);
  }
  scripts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const keys = Object.keys(picked)
    .filter((key) => key !== 'permissions')
    .concat(Object.keys(pickedPermissions ?? {}).map((key) => `permissions.${key}`))
    .sort();
  const detail = [
    JSON.stringify(picked, null, 2),
    ...(scripts.length > 0 ? ['', 'Scripts it runs:', ...scripts.map(([rel]) => `  ${rel}`)] : []),
  ].join('\n');
  return {
    digest: sha256(canonicalJson({ settings: picked, scripts })),
    keys,
    detail,
    approvable,
  };
}
