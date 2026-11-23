/** Explicit source build for the private Windows custody guardian. */
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildLocalWindowsPath,
  prepareWindowsCustodyManifest,
  readWindowsCompilerVersion,
  readWindowsCustodySources,
  readWindowsDeveloperEnvironment,
  WINDOWS_CUSTODY_ARTIFACT,
  WINDOWS_CUSTODY_INPUTS,
  WINDOWS_CUSTODY_MANIFEST,
  WINDOWS_CUSTODY_SDK,
  WINDOWS_CUSTODY_SOURCES,
  WINDOWS_CUSTODY_TARGETS,
  WINDOWS_CUSTODY_TOOLSET,
  windowsCustodyCompilerPaths,
} from './build-inputs.mjs';

const execute = promisify(execFile);
const sourceDirectory = new URL('../../../native/windows-run-custody/', import.meta.url);
const localHosts = new Set([
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PROGRAMDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'OS',
  'TEMP',
  'TMP',
]);

async function optionalEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function installedExecutable(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`Invalid installed tool: ${basename(path)}`);
  return buildLocalWindowsPath(await realpath(path));
}

export async function discoverWindowsCustodyToolchain() {
  const env = Object.fromEntries(
    Object.entries(process.env)
      .map(([key, value]) => [key.toUpperCase(), value])
      .filter(([key]) => localHosts.has(key))
  );
  const system = buildLocalWindowsPath(env.SYSTEMROOT);
  const systemBin = join(system, 'System32');
  const cmd = await installedExecutable(join(systemBin, 'cmd.exe'));
  env.COMSPEC = cmd;
  env.PATH = [systemBin, system, join(systemBin, 'Wbem')].join(';');
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  const vswhere = await installedExecutable(
    join(
      buildLocalWindowsPath(env['PROGRAMFILES(X86)']),
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe'
    )
  );
  const { stdout } = await execute(
    vswhere,
    [
      '-nologo',
      '-utf8',
      '-products',
      '*',
      '-version',
      '[17.0,18.0)',
      '-latest',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
      'Microsoft.VisualStudio.Component.Windows11SDK.26100',
      '-property',
      'installationPath',
    ],
    { env, windowsHide: true }
  );
  if (!stdout.trim()) throw new Error('VS 2022 with v143 x64/x86, ARM64 and SDK 26100 is required');
  const install = buildLocalWindowsPath(await realpath(buildLocalWindowsPath(stdout.trim())));
  const vcvars = await installedExecutable(
    join(install, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
  );
  return { env, cmd, install, auxiliary: dirname(vcvars) };
}

async function targetEnvironment(owner, target) {
  // All command text comes from this file. The installation path is only the cwd.
  const command = `"call .\\vcvarsall.bat ${target.vcvars} ${WINDOWS_CUSTODY_SDK} -vcvars_ver=${WINDOWS_CUSTODY_TOOLSET} >nul && set"`;
  const { stdout } = await execute(owner.cmd, ['/d', '/q', '/u', '/v:off', '/s', '/c', command], {
    cwd: owner.auxiliary,
    env: owner.env,
    encoding: 'buffer',
    windowsVerbatimArguments: true,
    windowsHide: true,
  });
  const env = readWindowsDeveloperEnvironment(stdout);
  const { cl, link, include, lib } = windowsCustodyCompilerPaths(owner.install, target, env);
  env.INCLUDE = include.join(';');
  env.LIB = lib.join(';');
  delete env.LIBPATH;
  for (const flag of ['CL', '_CL_', 'LINK', '_LINK_']) delete env[flag];
  return {
    env,
    cl: await installedExecutable(cl),
    link: await installedExecutable(link),
  };
}

async function requireUnchangedSources(root, expected) {
  const current = await readWindowsCustodySources(root);
  if (WINDOWS_CUSTODY_INPUTS.some((name) => !expected[name].equals(current[name]))) {
    throw new Error('Authored Windows custody sources changed during the build');
  }
}

/** Compile a reviewed native console entrypoint in its isolated source snapshot. */
export async function compileWindowsCustodyConsole(owner, target, cwd, sourceFiles, artifactName) {
  const { vcTarget } = target;
  const { cl, link, env } = await targetEnvironment(owner, target);
  const options = { cwd, env, windowsHide: true };
  const compile = await execute(
    cl,
    [
      '/nologo',
      '/Bv',
      '/c',
      '/TC',
      '/std:c11',
      '/W4',
      '/WX',
      '/MT',
      '/D_WIN32_WINNT=0x0a00',
      ...sourceFiles,
    ],
    options
  );
  const compiler = readWindowsCompilerVersion(compile.stdout + '\n' + compile.stderr);

  const linked = await execute(
    link,
    [
      '/nologo',
      '/SUBSYSTEM:CONSOLE',
      `/MACHINE:${vcTarget.toUpperCase()}`,
      `/OUT:${artifactName}`,
      ...sourceFiles.map((name) => basename(name, '.c') + '.obj'),
      'Kernel32.lib',
      'Advapi32.lib',
      'Bcrypt.lib',
    ],
    options
  );
  return {
    compiler,
    stdout: compile.stdout + linked.stdout,
    stderr: compile.stderr + linked.stderr,
  };
}

async function buildTarget(owner, target, scratch, output, sources) {
  const { architecture } = target;
  const result = join(output, architecture);
  const cwd = join(scratch, architecture);
  await mkdir(cwd);
  await mkdir(result);
  for (const name of WINDOWS_CUSTODY_INPUTS)
    await writeFile(join(cwd, name), sources[name], { flag: 'wx' });

  const { compiler } = await compileWindowsCustodyConsole(
    owner,
    target,
    cwd,
    WINDOWS_CUSTODY_SOURCES,
    WINDOWS_CUSTODY_ARTIFACT
  );
  await requireUnchangedSources(cwd, sources);
  const artifact = await readFile(join(cwd, WINDOWS_CUSTODY_ARTIFACT));
  const { manifest, manifestSha256, artifactSha256 } = prepareWindowsCustodyManifest({
    architecture,
    compiler,
    sdk: WINDOWS_CUSTODY_SDK,
    artifact,
    sources,
  });
  await writeFile(join(result, WINDOWS_CUSTODY_ARTIFACT), artifact, { flag: 'wx' });
  await writeFile(join(result, WINDOWS_CUSTODY_MANIFEST), manifest, { flag: 'wx' });
  return { architecture, manifestSha256, artifactSha256 };
}

async function hasPreparedDist(path) {
  const existing = await optionalEntry(path);
  if (!existing) return false;
  if (!existing.isDirectory()) throw new Error('Windows custody dist must be a real directory');
  for (const architecture of await readdir(path)) {
    const target = join(path, architecture);
    if (
      !WINDOWS_CUSTODY_TARGETS.some((entry) => entry.architecture === architecture) ||
      !(await lstat(target)).isDirectory()
    ) {
      throw new Error('Windows custody dist contains an unexpected entry');
    }
    for (const name of await readdir(target)) {
      if (
        (name !== WINDOWS_CUSTODY_ARTIFACT && name !== WINDOWS_CUSTODY_MANIFEST) ||
        !(await lstat(join(target, name))).isFile()
      ) {
        throw new Error('Windows custody output contains an unexpected entry');
      }
    }
  }
  return true;
}

async function build() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows custody setup requires an x64 Node process on Windows');
  }
  const root = buildLocalWindowsPath(await realpath(fileURLToPath(sourceDirectory)));
  const dist = join(root, 'dist');
  const lock = join(root, '.build-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error('A Windows custody build already owns this directory', { cause: error });
    throw error;
  }
  let scratch;
  let removeScratch = true;
  let outcome;
  try {
    await hasPreparedDist(dist);
    const owner = await discoverWindowsCustodyToolchain();
    const sources = await readWindowsCustodySources(root);
    scratch = await mkdtemp(join(root, '.build-'));
    const ready = join(scratch, 'ready');
    const previous = join(scratch, 'previous');
    await mkdir(ready);
    const records = [];
    for (const target of WINDOWS_CUSTODY_TARGETS) {
      records.push(await buildTarget(owner, target, scratch, ready, sources));
    }
    await requireUnchangedSources(root, sources);

    const replacing = await hasPreparedDist(dist);
    if (replacing) {
      await rename(dist, previous);
      removeScratch = false;
    }
    try {
      await rename(ready, dist);
      removeScratch = true;
    } catch (error) {
      if (replacing) {
        try {
          await rename(previous, dist);
          removeScratch = true;
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Could not restore the prior Windows custody build at ${previous}`,
            { cause: rollbackError }
          );
        }
      }
      throw error;
    }
    outcome = { records };
  } catch (error) {
    outcome = { error };
  }

  const cleanup = [];
  try {
    if (scratch && removeScratch) await rm(scratch, { recursive: true });
  } catch (error) {
    cleanup.push(error);
  }
  try {
    await rmdir(lock);
  } catch (error) {
    cleanup.push(error);
  }
  if (cleanup.length > 0) {
    const errors = outcome.error ? [outcome.error, ...cleanup] : cleanup;
    throw new AggregateError(errors, 'Windows custody build left local setup files');
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.records;
}

if (import.meta.main) {
  try {
    const records = await build();
    process.stdout.write(JSON.stringify(records, null, 2) + '\n');
  } catch (error) {
    const details =
      error instanceof AggregateError ? error.errors.map((cause) => cause.message) : [];
    process.stderr.write([error.message, ...details].join('\n') + '\n');
    process.exitCode = 1;
  }
}
