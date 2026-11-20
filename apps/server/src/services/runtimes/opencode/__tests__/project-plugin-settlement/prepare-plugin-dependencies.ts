/** Genuine locked public-package setup; native OpenCode remains offline. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const FIXTURE = fileURLToPath(new URL('./plugin-dependencies/', import.meta.url));
const SETUP_MS = 45_000;
import { runPreparationCommand } from './preparation-command.js';
interface LockedPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
}
interface Lock {
  packages: Record<string, LockedPackage>;
}

function accepts(values: string[] | undefined, value: string): boolean {
  if (!values) return true;
  return (
    !values.includes(`!${value}`) &&
    (!values.some((item) => !item.startsWith('!')) || values.includes(value))
  );
}

/** Only an explicitly unsupported optional OS/CPU package may be absent. */
export function optionalPlatformOmission(pkg: LockedPackage): boolean {
  return (
    pkg.optional === true && (!accepts(pkg.os, process.platform) || !accepts(pkg.cpu, process.arch))
  );
}

/** Refuse registry escapes and a substituted top-level pin before installing. */
export function validatePluginLock(lock: Lock): void {
  const plugin = lock.packages['node_modules/@opencode-ai/plugin'];
  if (plugin?.version !== '1.19.3') throw new Error('Wrong locked plugin pin');
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (!name.startsWith('node_modules/') || name.split('/').includes('..'))
      throw new Error('Invalid locked package path');
    const url = new URL(pkg.resolved ?? '');
    if (
      url.origin !== 'https://registry.npmjs.org' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !pkg.integrity?.startsWith('sha512-')
    )
      throw new Error('Invalid locked public package identity');
  }
}

/** Minimal preparation env: never inherit credentials, proxies or npm profiles. */
export function preparationEnv(cache: string, user: string, global: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'CODEX_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'TMPDIR',
    'LANG',
    'SystemRoot',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    npm_config_cache: cache,
    npm_config_userconfig: user,
    npm_config_globalconfig: global,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0',
  };
}

/** Hash every installed file/link; refuse links escaping this isolated package tree. */
async function installedSeal(directory: string): Promise<string> {
  const entries: string[] = [];
  const root = path.join(directory, 'node_modules');
  async function visit(dir: string): Promise<void> {
    for (const name of (await fs.readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const stat = await fs.lstat(full);
      const relative = path.relative(root, full);
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(full);
        if (!target.startsWith(root + path.sep))
          throw new Error('Installed package link escaped fixture');
        entries.push(`${relative}:link:${await fs.readlink(full)}`);
      } else if (stat.isDirectory()) await visit(full);
      else if (stat.isFile())
        entries.push(
          `${relative}:${createHash('sha256')
            .update(await fs.readFile(full))
            .digest('hex')}`
        );
      else throw new Error('Unexpected installed package file type');
    }
  }
  await visit(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Network setup only; all native calls stay inside their original test rows. */
export async function preparePluginDependencies(directory: string, scratch: string) {
  const deadline = performance.now() + SETUP_MS;
  await fs.mkdir(scratch, { recursive: false });
  const user = path.join(scratch, 'user.npmrc');
  const global = path.join(scratch, 'global.npmrc');
  await fs.writeFile(user, '');
  await fs.writeFile(global, '');
  const env = preparationEnv(path.join(scratch, 'cache'), user, global);
  const lockText = await fs.readFile(path.join(FIXTURE, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(lockText) as Lock;
  validatePluginLock(lock);
  // No project .npmrc may override the explicit public registry.
  try {
    await fs.access(path.join(directory, '.npmrc'));
    throw new Error('Unexpected fixture npm profile');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const packageText = await fs.readFile(path.join(FIXTURE, 'package.json'), 'utf8');
  await fs.writeFile(path.join(directory, 'package.json'), packageText);
  await fs.writeFile(path.join(directory, 'package-lock.json'), lockText);
  await runPreparationCommand(
    'ci',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    directory,
    env,
    deadline
  );
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    let actual: { version: string };
    try {
      actual = JSON.parse(await fs.readFile(path.join(directory, name, 'package.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && optionalPlatformOmission(pkg))
        continue;
      throw error;
    }
    if (actual.version !== pkg.version)
      throw new Error('Installed package version differs from lock');
  }
  await runPreparationCommand('ls', ['ls', '--all', '--json'], directory, env, deadline);
  const result = await dependencyResult(directory, packageText, lockText);
  if (performance.now() >= deadline)
    throw new Error('Plugin package preparation deadline exceeded');
  return result;
}

/** Snapshot the real installed tree; synthetic unit fixtures exercise this same consumer. */
export async function dependencyResult(directory: string, packageText: string, lockText: string) {
  const seal = await installedSeal(directory);
  return {
    seal,
    async verifyUnchanged() {
      if ((await installedSeal(directory)) !== seal)
        throw new Error('Installed plugin dependencies changed during native proof');
      if ((await fs.readFile(path.join(directory, 'package.json'), 'utf8')) !== packageText)
        throw new Error('Plugin dependency package changed during native proof');
      if ((await fs.readFile(path.join(directory, 'package-lock.json'), 'utf8')) !== lockText)
        throw new Error('Plugin dependency lock changed during native proof');
    },
  };
}
