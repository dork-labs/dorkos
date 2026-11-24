/** Keep exact private Windows witness outputs and raw logs from the opt-in hosted proof. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve('packages/test-utils/native/windows-run-custody');
const testRoot = join(root, 'tests');
const guardianFiles = ['windows-run-custody.exe', 'windows-run-custody.json'];
const companionFiles = ['owner-attempt-witness.exe', 'owner-attempt-witness.json'];
const compilerLogs = ['fixture-compile.stdout.log', 'fixture-compile.stderr.log'];
const runnerLogs = [
  'receipt.json',
  'test-events.jsonl',
  'test-stderr.log',
  'architecture.log',
  ...compilerLogs,
];

function requireDigest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('A separately captured Windows build digest is required');
  }
  return value;
}

async function child(script, args, logDirectory, basename) {
  const captured = await execute(process.execPath, [script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }).catch((error) => ({
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? '',
    error,
  }));
  await writeFile(join(logDirectory, basename + '.stdout.log'), captured.stdout, { flag: 'wx' });
  await writeFile(join(logDirectory, basename + '.stderr.log'), captured.stderr, { flag: 'wx' });
  return captured;
}

async function scratchDirectory(location) {
  const path = await realpath(fileURLToPath(location));
  const sourceRoot = await realpath(root);
  if (
    dirname(path).toLowerCase() !== sourceRoot.toLowerCase() ||
    !basename(path).startsWith('.build-witness-')
  ) {
    throw new Error('Unexpected Windows witness evidence directory');
  }
  return path;
}

async function copyFiles(from, to, names, optional = false) {
  await mkdir(to, { recursive: true });
  for (const name of names) {
    try {
      await copyFile(join(from, name), join(to, name), constants.COPYFILE_EXCL);
    } catch (error) {
      if (!optional || error.code !== 'ENOENT') throw error;
    }
  }
}

async function prepare(evidence) {
  const build = await child(
    resolve('packages/test-utils/src/run-custody/windows/build.mjs'),
    [],
    evidence,
    'guardian-build'
  );
  if (build.error) throw build.error;
  const manifests = JSON.parse(build.stdout);
  const digests = new Map(
    manifests.map((entry) => [entry.architecture, requireDigest(entry.manifestSha256)])
  );
  if (
    manifests.length !== 3 ||
    digests.size !== 3 ||
    !['x64', 'ia32', 'arm64'].every((arch) => digests.has(arch))
  ) {
    throw new Error('Windows build did not report the three exact architecture digests');
  }

  await appendFile(
    process.env.GITHUB_OUTPUT,
    Array.from(digests, ([arch, digest]) => arch + '_manifest=' + digest).join('\n') + '\n'
  );
}

async function prepareCompanion(handoff, evidence) {
  const guardianManifest = requireDigest(process.env.GUARDIAN_MANIFEST_SHA256);
  const previous = new Set(await readdir(root));
  const companion = await child(
    join(testRoot, 'prepare-arm64-witness-companion.mjs'),
    ['--guardian-manifest-sha256', guardianManifest],
    evidence,
    'arm64-companion-build'
  );
  if (companion.error) {
    const created = (await readdir(root)).filter(
      (name) => name.startsWith('.build-witness-arm64-') && !previous.has(name)
    );
    if (created.length === 1) {
      const scratch = await scratchDirectory(pathToFileURL(join(root, created[0])));
      await copyFiles(scratch, evidence, compilerLogs, true);
    }
    throw companion.error;
  }
  const selected = JSON.parse(companion.stdout);
  const companionSha256 = requireDigest(selected.manifestSha256);
  if (selected.architecture !== 'arm64' || selected.guardianManifestSha256 !== guardianManifest) {
    throw new Error('The prepared ARM64 companion belongs to a different guardian build');
  }
  const buildLogs = await scratchDirectory(selected.buildLogDirectory);
  const handoffLocation = await realpath(fileURLToPath(selected.handoffDirectory));
  if (handoffLocation.toLowerCase() !== join(buildLogs, 'handoff').toLowerCase()) {
    throw new Error('Unexpected ARM64 companion handoff directory');
  }
  await copyFiles(buildLogs, evidence, compilerLogs);
  await copyFiles(join(root, 'dist', 'arm64'), join(handoff, 'guardian'), guardianFiles);
  await copyFiles(handoffLocation, join(handoff, 'companion'), companionFiles);
  await appendFile(process.env.GITHUB_OUTPUT, 'arm64_companion=' + companionSha256 + '\n');
}

async function witness(arch, handoff, evidence) {
  const manifest = requireDigest(process.env.GUARDIAN_MANIFEST_SHA256);
  const args = ['--manifest-sha256', manifest];
  if (arch === 'arm64') {
    const companion = requireDigest(process.env.COMPANION_MANIFEST_SHA256);
    await copyFiles(join(handoff, 'guardian'), join(root, 'dist', 'arm64'), guardianFiles);
    args.push(
      '--companion-directory',
      join(handoff, 'companion'),
      '--companion-manifest-sha256',
      companion
    );
  }

  const execution = await child(
    join(testRoot, 'run-windows-witnesses.mjs'),
    args,
    evidence,
    'witness'
  );
  if (execution.stdout.trim()) {
    const receipt = JSON.parse(execution.stdout);
    await copyFiles(await scratchDirectory(receipt.logDirectory), evidence, runnerLogs, true);
    if (!execution.error && (receipt.status !== 'passed' || receipt.tests?.passed !== 11)) {
      throw new Error('Windows witness did not record eleven passing native cases');
    }
  } else if (!execution.error) {
    throw new Error('Windows witness produced no receipt');
  }
  if (execution.error) throw execution.error;
}

/** Build with the selected Node distribution's own tool and a fresh per-run SDK directory. */
async function inboxWitness(temporary, evidence) {
  const { arch, versions } = process;
  const inbox = join(root, 'inbox');
  const gyp = join(dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'node-gyp');
  const cache = await mkdtemp(join(temporary, 'custody-inbox-node-sdk-'));
  const build = await child(
    join(gyp, 'bin', 'node-gyp.js'),
    [
      'rebuild',
      '--directory=' + inbox,
      '--target=' + versions.node,
      '--arch=' + arch,
      '--devdir=' + cache,
      '--dist-url=https://nodejs.org/dist',
    ],
    evidence,
    'build'
  );
  if (build.error) throw build.error;

  // node-gyp checks its newly downloaded headers and node.lib against Node's release sums.
  const sdk = join(cache, versions.node);
  const includes = join(sdk, 'include', 'node');
  const header = await readFile(join(includes, 'node_version.h'), 'utf8');
  const version = ['MAJOR', 'MINOR', 'PATCH']
    .map(
      (part) =>
        header.match(new RegExp('^#define NODE_' + part + '_VERSION\\s+(\\d+)\\s*$', 'm'))?.[1]
    )
    .join('.');
  if (version !== versions.node) throw new Error('The built inbox headers do not match this Node');

  const digest = async (file) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  const file = 'custody_inbox.node';
  const compiled = join(inbox, 'build', 'Release', file);
  const retained = join(evidence, file);
  await copyFile(compiled, retained, constants.COPYFILE_EXCL);
  const artifactSha256 = await digest(retained);
  const inputs = {
    node: versions.node,
    architecture: arch,
    nodeGyp: JSON.parse(await readFile(join(gyp, 'package.json'), 'utf8')).version,
    headersVersion: version,
    nodeApiHeaderSha256: await digest(join(includes, 'node_api.h')),
    nodeLibSha256: await digest(join(sdk, arch, 'node.lib')),
    artifactSha256,
  };
  await writeFile(join(evidence, 'build.json'), JSON.stringify(inputs, null, 2) + '\n', {
    flag: 'wx',
  });

  const result = await child(join(inbox, 'inbox-witness.mjs'), [], evidence, 'witness');
  if (result.error) throw result.error;
  const observed = JSON.parse(result.stdout);
  if (
    observed.platform !== 'win32' ||
    observed.arch !== arch ||
    observed.directory !== 'removed' ||
    observed.workerIdentityMatched !== true ||
    observed.inheritedRecordAcl !== true ||
    (await digest(compiled)) !== artifactSha256
  )
    throw new Error('Windows inbox fixture did not confirm this build and its cleanup');
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(observed, null, 2) + '\n', {
    flag: 'wx',
  });
}

async function main() {
  const [phase, scope, ...remaining] = process.argv.slice(2);
  const phases = {
    prepare: ['x64', '24.19.0'],
    companion: ['x64', '24.19.0'],
    x64: ['x64', '24.19.0'],
    ia32: ['ia32', '22.23.3'],
    arm64: ['arm64', '24.19.0'],
  };
  if (
    remaining.length ||
    !Object.hasOwn(phases, phase) ||
    (scope !== undefined && (scope !== 'inbox' || !['x64', 'ia32', 'arm64'].includes(phase)))
  ) {
    throw new Error('Choose one Windows custody proof phase');
  }
  const [expectedArch, expectedVersion] = phases[phase];
  if (
    process.platform !== 'win32' ||
    process.arch !== expectedArch ||
    process.versions.node !== expectedVersion
  ) {
    throw new Error(
      `Windows custody proof requires Node ${expectedVersion} ${expectedArch} on Windows`
    );
  }
  const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { windowsHide: true });
  const sourceCommit = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || sourceCommit !== process.env.EXPECTED_HEAD) {
    throw new Error('Windows witness checkout does not match the reviewed pull request head');
  }
  const temporary = await realpath(process.env.RUNNER_TEMP);
  const handoff = join(temporary, 'windows-custody-handoff');
  const evidence = join(temporary, 'windows-custody-evidence', phase, scope ?? '');
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, 'provenance.json'),
    JSON.stringify(
      {
        phase,
        sourceCommit,
        node: process.version,
        architecture: process.arch,
        runnerArchitecture: process.env.RUNNER_ARCH,
        image: process.env.ImageOS,
        imageVersion: process.env.ImageVersion,
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
      },
      null,
      2
    ) + '\n',
    { flag: 'wx' }
  );

  if (scope === 'inbox') await inboxWitness(temporary, evidence);
  else if (phase === 'prepare') await prepare(evidence);
  else if (phase === 'companion') await prepareCompanion(handoff, evidence);
  else await witness(phase, handoff, evidence);
}

try {
  await main();
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
