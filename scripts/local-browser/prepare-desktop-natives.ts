/** Qualification-only native staging; never rebuilds workspace packages or the installed app. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {
  root,
  candidate,
  modules,
  exec,
  inside,
  packageInfo,
  packageRoot,
  binaries,
  sharedLanePath,
  compilerEnvironment,
  compilerArguments,
  actualTargetPlan,
  assertPrivatePlan,
  verifyTargetPlan,
  compilerGroup,
  closeCompilerGroup,
  type Binary,
  type Package,
} from './desktop-native-support.js';

async function run(): Promise<void> {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  const lane = JSON.parse(await readFile(await sharedLanePath(), 'utf8')) as {
    root: string;
    scope: string;
  };
  assert(
    lane.root === root && lane.scope.includes('desktop-natives'),
    'Use run-in-lane.py after root grants the staging window'
  );
  assert.equal(await realpath(candidate), candidate, 'Candidate must be the exact worktree bundle');
  const resources = path.join(candidate, 'Contents/Resources');
  const unpacked = path.join(resources, 'app.asar.unpacked');
  await access(unpacked);
  const output = path.join(root, '.dork/local-browser/native-staging', String(Date.now()));
  const stage = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-private-natives-')));
  assert(!inside(stage, root), 'Private native staging must be outside checkout');
  await mkdir(output, { recursive: true, mode: 0o700 });
  await mkdir(path.join(stage, 'node_modules'), { recursive: true, mode: 0o700 });
  const frameworkPlist = path.join(
    candidate,
    'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist'
  );
  const electronVersion = (
    await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', frameworkPlist])
  ).stdout.trim();
  assert(/^\d+\.\d+\.\d+$/.test(electronVersion));
  const desktop = path.join(root, 'apps/desktop');
  const sources = new Map<string, string>();
  for (const name of [...modules, '@electron/rebuild'])
    sources.set(name, await packageRoot(desktop, name));
  const before: Record<string, Binary[]> = Object.fromEntries(
    await Promise.all(modules.map(async (name) => [name, await binaries(sources.get(name)!)]))
  );
  for (const name of modules)
    assert(before[name].length > 0, `Source ${name} native-bin positive control is empty`);
  const receipt: Record<string, unknown> = {
    status: 'running',
    output,
    stage,
    candidate,
    electronVersion,
    architecture: process.arch,
    qualificationOnly: true,
    sourceBefore: before,
    copiedPackages: [],
    candidateCopies: [],
  };
  const copies = receipt.copiedPackages as {
    name: string;
    version: string;
    source: string;
    target: string;
  }[];

  async function stagePackage(
    name: string,
    source: string,
    target: string,
    ancestors: Map<string, string>
  ): Promise<void> {
    assert(inside(target, stage));
    const metadata = await packageInfo(source);
    // cp uses independent byte copies. Nested dependency trees are rebuilt explicitly, never followed through pnpm links.
    await cp(source, target, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
      filter: (file) => path.relative(source, file).split(path.sep)[0] !== 'node_modules',
    });
    copies.push({ name, version: metadata.version, source, target });
    const scope = new Map(ancestors);
    scope.set(name, source);
    for (const [dependency, optional] of Object.entries({
      ...Object.fromEntries(Object.keys(metadata.dependencies ?? {}).map((key) => [key, false])),
      ...Object.fromEntries(
        Object.keys(metadata.optionalDependencies ?? {}).map((key) => [key, true])
      ),
    })) {
      let dependencySource: string;
      try {
        dependencySource = await packageRoot(source, dependency);
      } catch (error) {
        if (optional) continue;
        throw error;
      }
      if (scope.get(dependency) === dependencySource) continue;
      await stagePackage(
        dependency,
        dependencySource,
        path.join(target, 'node_modules', dependency),
        scope
      );
    }
  }

  try {
    // Immutable original byte backups are outside every rebuild target, for coordinated recovery only.
    for (const name of modules) {
      for (const binary of before[name]) {
        const backup = path.join(output, 'original-binaries', name, binary.relative);
        await mkdir(path.dirname(backup), { recursive: true });
        await copyFile(path.join(sources.get(name)!, binary.relative), backup);
        assert.equal(
          createHash('sha256')
            .update(await readFile(backup))
            .digest('hex'),
          binary.sha256
        );
        await chmod(backup, 0o400);
      }
    }
    for (const [name, source] of sources)
      await stagePackage(name, source, path.join(stage, 'node_modules', name), new Map());
    await writeFile(
      path.join(stage, 'package-lock.json'),
      JSON.stringify({
        name: 'dorkos-private-native-qualification',
        lockfileVersion: 3,
        packages: {},
      })
    );
    const versions: Record<string, string> = Object.fromEntries(
      await Promise.all(
        [...sources].map(async ([name, source]) => [name, (await packageInfo(source)).version])
      )
    );
    await writeFile(
      path.join(stage, 'package.json'),
      JSON.stringify(
        {
          name: 'dorkos-private-native-qualification',
          private: true,
          version: '1.0.0',
          dependencies: Object.fromEntries(modules.map((name) => [name, versions[name]])),
          devDependencies: { '@electron/rebuild': versions['@electron/rebuild'] },
        },
        null,
        2
      )
    );
    // Current node-pty is N-API based. Its gyp expression must resolve inside this private package tree.
    const addonApi = await packageRoot(path.join(stage, 'node_modules/node-pty'), 'node-addon-api');
    assert(inside(addonApi, stage));
    receipt.nodeAddonApi = { path: addonApi, version: (await packageInfo(addonApi)).version };
    const bindings = await packageRoot(path.join(stage, 'node_modules/better-sqlite3'), 'bindings');
    const fileUri = await packageRoot(bindings, 'file-uri-to-path');
    assert(inside(bindings, stage) && inside(fileUri, stage));
    receipt.addonDependencies = { bindings, fileUri };
    for (const name of modules) {
      const staged = await binaries(path.join(stage, 'node_modules', name));
      for (const file of staged) {
        const original = before[name].find((binary) => binary.relative === file.relative);
        assert(original && original.sha256 === file.sha256);
        assert(
          original.inode !== file.inode || original.device !== file.device,
          'Staging must not hardlink a workspace binary'
        );
        assert.equal((await stat(path.join(stage, 'node_modules', name, file.relative))).nlink, 1);
      }
    }
    const rebuild = path.join(stage, 'node_modules/@electron/rebuild');
    const cachePatches = [
      [
        'lib/constants.js',
        "path.resolve(os.homedir(), '.electron-gyp')",
        JSON.stringify(path.join(stage, 'electron-gyp')),
      ],
      [
        'lib/rebuild.js',
        "path.resolve(os.homedir(), '.electron-rebuild-cache')",
        JSON.stringify(path.join(stage, 'rebuild-cache')),
      ],
    ];
    for (const [relative, original, replacement] of cachePatches) {
      const file = path.join(rebuild, relative);
      const text = await readFile(file, 'utf8');
      assert.equal(
        text.split(original).length,
        2,
        `Private rebuild cache patch drifted: ${relative}`
      );
      await writeFile(file, text.replace(original, replacement));
    }
    const cliFile = path.join(rebuild, 'lib/cli.js');
    const cliSource = await readFile(cliFile, 'utf8');
    const ancestorRoot = 'await getProjectRootPath(process.cwd())';
    assert.equal(
      cliSource.split(ancestorRoot).length,
      2,
      'Private CLI project boundary patch drifted'
    );
    await writeFile(cliFile, cliSource.replace(ancestorRoot, JSON.stringify(stage)));
    // Enforce confinement again at the actual execution boundary, even if selection changes.
    const rebuildFile = path.join(rebuild, 'lib/rebuild.js');
    const rebuildSource = await readFile(rebuildFile, 'utf8');
    const dispatch = 'async rebuildModuleAt(modulePath) {';
    assert.equal(rebuildSource.split(dispatch).length, 2);
    await writeFile(
      rebuildFile,
      rebuildSource.replace(
        dispatch,
        dispatch +
          `\n        const confined = await fs.promises.realpath(modulePath);\n        if (!confined.startsWith(${JSON.stringify(stage + path.sep)})) throw new Error('Private rebuild dispatch escaped: ' + confined);`
      )
    );
    const plan = await actualTargetPlan(rebuild, stage, stage);
    assertPrivatePlan(plan, stage);
    receipt.preplannedTargets = plan;
    const privateResolve = createRequire(path.join(stage, 'package.json'));
    assert(inside(await realpath(privateResolve.resolve('@electron/rebuild')), stage));
    const gyp = await packageRoot(rebuild, 'node-gyp');
    assert(inside(gyp, stage));
    receipt.nodeGyp = { path: gyp, version: (await packageInfo(gyp)).version };
    // Strip inherited npm/gyp/Python controls before adding private cache paths.
    // eslint-disable-next-line no-restricted-syntax
    const environment = compilerEnvironment(process.env, stage);
    const log = createWriteStream(path.join(output, 'electron-rebuild.log'));
    const compiler = spawn(process.execPath, compilerArguments(rebuild, stage, electronVersion), {
      cwd: stage,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    compiler.stdout!.pipe(log, { end: false });
    compiler.stderr!.pipe(log, { end: false });
    let timer: NodeJS.Timeout | undefined;
    let exit: number | null = null;
    const observed = new Set<number>();
    try {
      assert(compiler.pid, 'Compiler did not receive an owned PID');
      receipt.compilerGroup = compiler.pid;
      observed.add(compiler.pid);
      exit = await new Promise<number | null>((resolve, reject) => {
        compiler.once('error', reject);
        compiler.once('exit', resolve);
        timer = setTimeout(
          () => reject(new Error('Private compiler exceeded 180-second deadline')),
          180_000
        );
        timer.unref();
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (compiler.pid) {
        (await closeCompilerGroup(compiler.pid)).forEach((pid) => observed.add(pid));
        receipt.compilerPids = [...observed];
        receipt.compilerGroupPhysicallyClosed = (await compilerGroup(compiler.pid)).length === 0;
      }
      await new Promise<void>((resolve) => log.end(resolve));
    }
    assert.equal(exit, 0, 'Private electron-rebuild did not complete');
    const rebuilt: Record<string, Binary[]> = Object.fromEntries(
      await Promise.all(
        modules.map(async (name) => [name, await binaries(path.join(stage, 'node_modules', name))])
      )
    );
    receipt.stagedAfter = rebuilt;
    assert(
      rebuilt['better-sqlite3'].some(
        (binary) => binary.relative === 'build/Release/better_sqlite3.node'
      )
    );
    assert(
      rebuilt['node-pty'].some(
        (binary) =>
          binary.relative === 'build/Release/pty.node' ||
          binary.relative === 'prebuilds/darwin-arm64/pty.node'
      )
    );

    const unchanged = Object.fromEntries(
      await Promise.all(modules.map(async (name) => [name, await binaries(sources.get(name)!)]))
    );
    assert.deepEqual(unchanged, before, 'Shared native bins changed; refuse candidate mutation');
    const targets = new Map<string, string[]>();
    async function locate(current: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await locate(file);
        else if (entry.name === 'package.json') {
          const metadata = JSON.parse(await readFile(file, 'utf8')) as Package;
          if ((modules as readonly string[]).includes(metadata.name)) {
            assert.equal(metadata.version, versions[metadata.name]);
            targets.set(metadata.name, [...(targets.get(metadata.name) ?? []), path.dirname(file)]);
          }
        }
      }
    }
    await locate(unpacked);
    for (const name of modules) {
      const roots = targets.get(name);
      assert(roots?.length, `Candidate has no unpacked ${name} package`);
      for (const target of roots) {
        assert(inside(await realpath(target), unpacked));
        const current = await binaries(target);
        let selected: { source: Binary; destination: string }[];
        if (name === 'better-sqlite3') {
          const binary = rebuilt[name].find(
            (file) => file.relative === 'build/Release/better_sqlite3.node'
          );
          assert(binary);
          assert(current.some((file) => file.relative === binary.relative));
          selected = [{ source: binary, destination: binary.relative }];
        } else {
          const binary =
            rebuilt[name].find((file) => file.relative === 'build/Release/pty.node') ??
            rebuilt[name].find((file) => file.relative === 'prebuilds/darwin-arm64/pty.node');
          const original = [
            'build/Release/pty.node',
            'build/Debug/pty.node',
            'prebuilds/darwin-arm64/pty.node',
          ]
            .map((relative) => current.find((file) => file.relative === relative))
            .find(Boolean);
          assert(binary && original);
          const sourceHelper = rebuilt[name].find(
            (file) => file.relative === path.join(path.dirname(binary.relative), 'spawn-helper')
          );
          const targetHelper = path.join(path.dirname(original.relative), 'spawn-helper');
          assert(sourceHelper && current.some((file) => file.relative === targetHelper));
          // Replace existing archive-mapped paths: new unpacked files alone do not add ASAR entries.
          selected = [
            { source: binary, destination: original.relative },
            { source: sourceHelper, destination: targetHelper },
          ];
        }
        for (const { source: binary, destination: relative } of selected) {
          const source = path.join(stage, 'node_modules', name, binary.relative);
          const destination = path.join(target, relative);
          await mkdir(path.dirname(destination), { recursive: true });
          assert(inside(await realpath(path.dirname(destination)), unpacked));
          // Atomic replacement breaks any candidate hardlink instead of truncating its shared source inode.
          const temporary = destination + `.private-native-${process.pid}`;
          await copyFile(source, temporary);
          await chmod(temporary, binary.mode & 0o777);
          await rename(temporary, destination);
          const metadata = await lstat(destination);
          assert(!metadata.isSymbolicLink());
          assert.equal(metadata.nlink, 1);
          const installed = createHash('sha256')
            .update(await readFile(destination))
            .digest('hex');
          assert.equal(installed, binary.sha256);
          (receipt.candidateCopies as unknown[]).push({
            module: name,
            stagedRelative: binary.relative,
            candidateRelative: relative,
            path: destination,
            sha256: installed,
            inode: metadata.ino,
          });
        }
      }
    }
    receipt.status = 'prepared-private-candidate-natives';
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    const after = Object.fromEntries(
      await Promise.all(modules.map(async (name) => [name, await binaries(sources.get(name)!)]))
    );
    receipt.sourceAfter = after;
    try {
      assert.deepEqual(after, before, 'Shared source native bins changed during qualification');
      receipt.sharedNativeBinsUnchanged = true;
    } catch (error) {
      receipt.status = 'failed';
      receipt.error = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(
      JSON.stringify({
        output,
        status: receipt.status,
        sharedNativeBinsUnchanged: receipt.sharedNativeBinsUnchanged,
        error: receipt.error,
      })
    );
  }
}

if (process.argv.includes('--verify-target-plan')) await verifyTargetPlan();
else if (process.argv.includes('--execute')) await run();
else
  console.log(
    'Prepared private native staging helper. Native execution requires root authorization and the desktop-natives lane.'
  );
