#!/usr/bin/env node
/**
 * What the space image installs (server-merge step 7f). The space image ships the space server
 * alone: never the machine store, a runtime SDK, a terminal or the DorkOS server itself. Its
 * imports are checked by the space server's import guard; this checks what is INSTALLED, after
 * `pnpm deploy`, because a package can arrive without being imported. `drizzle-orm` brings
 * `better-sqlite3` in as an optional peer the workspace resolves, and nothing in the space
 * server loads it.
 *
 * Usage: node scripts/space-image/runtime-packages.mjs <deployed-folder> [--prune]
 *   --prune  first removes the packages the space server never loads (PRUNED), and every link
 *            left pointing at nothing.
 * Exits 1, naming them, when a forbidden package is installed.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Packages the space image must never install, with why. */
export const FORBIDDEN_PACKAGES = {
  'better-sqlite3': 'the machine store',
  '@types/better-sqlite3': 'the machine store',
  '@dorkos/db': 'the machine store',
  '@dorkos/server': 'the DorkOS server',
  '@anthropic-ai/claude-agent-sdk': 'a runtime SDK',
  '@openai/codex-sdk': 'a runtime SDK',
  '@opencode-ai/sdk': 'a runtime SDK',
  'node-pty': 'the terminal',
  '@ngrok/ngrok': 'the tunnel',
};

/** Installed only as unused optional peers; removed from the image before the check. */
export const PRUNED = ['better-sqlite3', '@types/better-sqlite3'];

/** A pnpm store folder's package name: `@scope+name@1.2.3_peer` is `@scope/name`. */
function storeName(folder) {
  const at = folder.indexOf('@', folder.startsWith('@') ? 1 : 0);
  return (at === -1 ? folder : folder.slice(0, at)).replace('+', '/');
}

/** Every package name installed under `<dir>/node_modules`, from the store and the top level. */
export function installedPackages(dir) {
  const modules = join(dir, 'node_modules');
  const names = new Set();
  const store = join(modules, '.pnpm');
  if (existsSync(store))
    for (const folder of readdirSync(store))
      if (folder !== 'node_modules' && !folder.startsWith('.')) names.add(storeName(folder));
  if (existsSync(modules))
    for (const entry of readdirSync(modules)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@'))
        for (const scoped of readdirSync(join(modules, entry))) names.add(`${entry}/${scoped}`);
      else names.add(entry);
    }
  return names;
}

/** Remove every symbolic link under `root` whose target no longer exists. */
function removeDanglingLinks(root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      if (!existsSync(path)) rmSync(path);
    } else if (entry.isDirectory()) removeDanglingLinks(path);
  }
}

/** Remove the {@link PRUNED} packages from `<dir>/node_modules`, and the links to them. */
export function prune(dir) {
  const modules = join(dir, 'node_modules');
  const store = join(modules, '.pnpm');
  if (existsSync(store))
    for (const folder of readdirSync(store))
      if (PRUNED.includes(storeName(folder)))
        rmSync(join(store, folder), { recursive: true, force: true });
  for (const name of PRUNED) {
    const top = join(modules, name);
    if (existsSync(top) || isLink(top)) rmSync(top, { recursive: true, force: true });
  }
  removeDanglingLinks(modules);
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The forbidden packages installed under `dir`, each as "<name> (<why>)". */
export function forbiddenInstalled(dir) {
  const installed = installedPackages(dir);
  return Object.entries(FORBIDDEN_PACKAGES)
    .filter(([name]) => installed.has(name))
    .map(([name, why]) => `${name} (${why})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, flag] = process.argv.slice(2);
  if (!dir) {
    console.error(
      'Usage: node scripts/space-image/runtime-packages.mjs <deployed-folder> [--prune]'
    );
    process.exit(2);
  }
  if (flag === '--prune') prune(dir);
  const installed = installedPackages(dir);
  if (installed.size === 0) {
    console.error(`No packages under ${dir}/node_modules: nothing was checked.`);
    process.exit(1);
  }
  const found = forbiddenInstalled(dir);
  if (found.length > 0) {
    console.error(`The space image must not install: ${found.join(', ')}.`);
    process.exit(1);
  }
  console.log(`space image: ${installed.size} packages installed, none forbidden.`);
}
