/** Private native staging checks and bounded compiler process custody. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const root = process.cwd();
export const candidate = path.resolve(root, 'apps/desktop/release/mac-arm64/DorkOS.app');

export const modules = ['better-sqlite3', 'node-pty'] as const;
export const exec = promisify(execFile);
export interface Package {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
export interface Binary {
  relative: string;
  sha256: string;
  inode: number;
  device: number;
  mode: number;
}
/** Check path confinement without following an unrelated tree. */
export function inside(file: string, directory: string): boolean {
  return file === directory || file.startsWith(directory + path.sep);
}
/** Read installed package metadata without loading package code. */
export async function packageInfo(directory: string): Promise<Package> {
  return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as Package;
}
/** Locate the installed package through its own module resolution. */
export async function packageRoot(from: string, name: string): Promise<string> {
  const resolve = createRequire(path.join(from, 'package.json'));
  try {
    return await realpath(path.dirname(resolve.resolve(`${name}/package.json`)));
  } catch {
    /* Some packages restrict package.json exports. */
  }
  let current = path.dirname(await realpath(resolve.resolve(name)));
  while (current !== path.dirname(current)) {
    try {
      await access(path.join(current, 'package.json'));
      return current;
    } catch {
      current = path.dirname(current);
    }
  }
  throw new Error(`Could not locate installed package ${name}`);
}
/** Record native binary contents and physical file identity. */
export async function binaries(directory: string): Promise<Binary[]> {
  const result: Binary[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        assert(
          !entry.name.endsWith('.node') && entry.name !== 'spawn-helper',
          `Native runtime binary must not be a symlink: ${file}`
        );
        continue;
      }
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith('.node') || entry.name === 'spawn-helper') {
        const metadata = await stat(file);
        result.push({
          relative: path.relative(directory, file),
          sha256: createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
          inode: metadata.ino,
          device: metadata.dev,
          mode: metadata.mode,
        });
      }
    }
  }
  await visit(directory);
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}
/** Locate the shared exclusive verification marker. */
export async function sharedLanePath(): Promise<string> {
  // Verification can share an operator-provided lane; otherwise use the original clone's workspace.
  // eslint-disable-next-line no-restricted-syntax
  const override = process.env.LOCAL_BROWSER_LANE_FILE;
  if (override) return path.resolve(override);
  const common = (
    await exec('git', ['rev-parse', '--git-common-dir'], { cwd: root })
  ).stdout.trim();
  return path.join(
    path.dirname(path.dirname(path.resolve(root, common))),
    '.workspace/shared-local-heavy-producer.lock'
  );
}

/** Remove inherited build controls and confine compiler caches. */
export function compilerEnvironment(
  inherited: NodeJS.ProcessEnv,
  stage: string
): NodeJS.ProcessEnv {
  const safe = Object.fromEntries(
    Object.entries(inherited).filter(([name]) => {
      const upper = name.toUpperCase();
      return (
        !/(?:KEY|TOKEN|SECRET|PASSWORD|PAID|CREDENTIALED|HARNESS_SMOKE|COMMUNITY_LIVE)/.test(
          upper
        ) &&
        !/^(?:NPM_CONFIG_|NPM_PACKAGE_CONFIG_NODE_GYP_|GYP)/.test(upper) &&
        ![
          'NODE_OPTIONS',
          'NODE_PATH',
          'DEBUG',
          'BASH_ENV',
          'ENV',
          'ZDOTDIR',
          'PYTHONPATH',
          'PYTHONHOME',
          'PYTHONSTARTUP',
          'NODE_GYP_FORCE_PYTHON',
          'MAKEFLAGS',
          'MFLAGS',
        ].includes(upper)
      );
    })
  );
  return {
    ...safe,
    npm_config_cache: path.join(stage, 'npm-cache'),
    NPM_CONFIG_CACHE: path.join(stage, 'npm-cache'),
    npm_config_devdir: path.join(stage, 'electron-gyp'),
    NPM_CONFIG_DEVDIR: path.join(stage, 'electron-gyp'),
  };
}
/** Build arguments for the two explicitly owned native packages. */
export function compilerArguments(rebuild: string, stage: string, version: string): string[] {
  return [
    path.join(rebuild, 'lib/cli.js'),
    '-f',
    '-v',
    version,
    '-a',
    'arm64',
    '-m',
    stage,
    '--only',
    modules.join(','),
    '--sequential',
    '--build-from-source',
  ];
}
function verifyCompilerIsolation(): void {
  const hostileNames = [
    'npm_config_path',
    'NPM_CONFIG_CACHE',
    'NpM_CoNfIg_node_gyp',
    'npm_package_config_node_gyp_nodedir',
    'GYP_DEFINES',
    'gyp_generator_flags',
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONSTARTUP',
    'NODE_GYP_FORCE_PYTHON',
    'MAKEFLAGS',
    'MFLAGS',
    'NODE_PATH',
    'OPENAI_API_KEY',
  ];
  const stage = '/private/native-regression';
  const safe = compilerEnvironment(
    {
      HOME: '/preserved/home',
      CODEX_HOME: '/preserved/codex',
      PATH: '/usr/bin:/bin',
      ...Object.fromEntries(hostileNames.map((name) => [name, '/foreign/escape'])),
    },
    stage
  );
  for (const name of hostileNames)
    assert(
      safe[name] === undefined || safe[name] === path.join(stage, 'npm-cache'),
      `Hostile compiler variable survived: ${name}`
    );
  assert.equal(safe.HOME, '/preserved/home');
  assert.equal(safe.CODEX_HOME, '/preserved/codex');
  assert.equal(safe.npm_config_devdir, path.join(stage, 'electron-gyp'));
  assert.equal(safe.NPM_CONFIG_DEVDIR, path.join(stage, 'electron-gyp'));
  const args = compilerArguments('/private/rebuild', stage, '41.10.7');
  assert(args.includes('--build-from-source'));
  assert.equal(args[args.indexOf('-m') + 1], stage);
  assert.equal(args[args.indexOf('--only') + 1], 'better-sqlite3,node-pty');
}

interface Walker {
  nodeModulesPaths: Promise<string[]>;
  modulesToRebuild: string[];
  walkModules(): Promise<void>;
  findAllModulesIn(directory: string): Promise<void>;
}
/** Ask the installed rebuild walker which private modules it would select. */
export async function actualTargetPlan(
  rebuild: string,
  stage: string,
  boundary: string
): Promise<{ targets: string[]; scanned: string[] }> {
  const { ModuleWalker } = (await import(
    pathToFileURL(path.join(rebuild, 'lib/module-walker.js')).href
  )) as {
    ModuleWalker: new (
      stage: string,
      boundary: string,
      types: string[],
      dependencies: Set<string>,
      only: string[]
    ) => Walker;
  };
  const walker = new ModuleWalker(stage, boundary, ['prod', 'optional'], new Set(), [...modules]);
  await walker.walkModules();
  const scanned = await walker.nodeModulesPaths;
  for (const directory of scanned) await walker.findAllModulesIn(directory);
  return {
    targets: await Promise.all(walker.modulesToRebuild.map((target) => realpath(target))),
    scanned: await Promise.all(scanned.map((directory) => realpath(directory))),
  };
}
/** Refuse native selection outside the private stage or expected pair. */
export function assertPrivatePlan(
  plan: { targets: string[]; scanned: string[] },
  stage: string
): void {
  assert(plan.targets.length === 2, 'Expected exactly two private addon targets');
  for (const target of [...plan.targets, ...plan.scanned])
    assert(inside(target, stage), `Rebuild target/scan escaped private boundary: ${target}`);
  assert.deepEqual(plan.targets.map((target) => path.basename(target)).sort(), [...modules].sort());
}
/** Uses the installed walker's real selection algorithm, without compiling or loading native code. */
export async function verifyTargetPlan(): Promise<void> {
  verifyCompilerIsolation();
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-native-plan-')));
  const stage = path.join(fixture, 'nested/private');
  try {
    for (const directory of [fixture, stage]) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, 'package.json'),
        JSON.stringify({ dependencies: Object.fromEntries(modules.map((name) => [name, '1.0.0'])) })
      );
      for (const name of modules) {
        const target = path.join(directory, 'node_modules', name);
        await mkdir(target, { recursive: true });
        await writeFile(
          path.join(target, 'package.json'),
          JSON.stringify({ name, version: '1.0.0' })
        );
        await writeFile(path.join(target, 'binding.gyp'), '{}');
      }
    }
    const rebuild = await packageRoot(path.join(root, 'apps/desktop'), '@electron/rebuild');
    const unsafe = await actualTargetPlan(rebuild, stage, fixture);
    assert(
      unsafe.targets.some((target) => !inside(target, stage)),
      'Positive control must reproduce ancestor module scheduling'
    );
    assert.throws(() => assertPrivatePlan(unsafe, stage));
    const safe = await actualTargetPlan(rebuild, stage, stage);
    assertPrivatePlan(safe, stage);
    console.log(
      JSON.stringify({
        status: 'target-plan-regression-passed',
        unsafeTargetCount: unsafe.targets.length,
        safe,
      })
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

/** Only the detached compiler's new process group is ever signalled. */
export async function compilerGroup(group: number): Promise<number[]> {
  const result = await exec('/bin/ps', ['-axo', 'pid=,pgid='], { timeout: 2_000 });
  return result.stdout.split('\n').flatMap((line) => {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number);
    return pgid === group && pid > 0 ? [pid] : [];
  });
}
/** Close only the explicitly owned detached compiler group and attest absence. */
export async function closeCompilerGroup(group: number): Promise<number[]> {
  const observed = new Set(await compilerGroup(group));
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if ((await compilerGroup(group)).length === 0) return [...observed];
    try {
      process.kill(-group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const deadline = Date.now() + 2_000;
    do {
      const current = await compilerGroup(group);
      current.forEach((pid) => observed.add(pid));
      if (current.length === 0) return [...observed];
      await delay(100);
    } while (Date.now() < deadline);
  }
  assert.deepEqual(await compilerGroup(group), [], 'Owned compiler process group did not close');
  return [...observed];
}
