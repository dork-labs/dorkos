/** Opt-in native witness run against the independently selected private guardian build. */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { promisify } from 'node:util';
import {
  WINDOWS_CUSTODY_TARGETS,
  windowsCustodySha256,
} from '../../../src/run-custody/windows/build-inputs.mjs';
import {
  compileOwnerWitness,
  nativeFixture,
  parseWindowsWitnessArguments,
  readGuardianWitnessInputs,
  readOwnerWitnessArtifact,
  readPreparedArm64Companion,
} from './witness-companion.mjs';
import {
  readWitnessArchitecture,
  summarizeWitnessEvents,
  witnessFiles,
} from './witness-reporter.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
function fixtureEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => /^(systemroot|windir|temp|tmp)$/i.test(name))
  );
}

async function checkedExecute(file, args, cwd) {
  return execute(file, args, {
    cwd,
    env: fixtureEnvironment(),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function recordTestRun(directory) {
  const reporter = new URL('./witness-reporter.mjs', import.meta.url).href;
  const args = [
    '--test',
    '--test-concurrency=1',
    '--test-reporter',
    reporter,
    ...witnessFiles.map((file) => fileURLToPath(new URL(file, import.meta.url))),
  ];
  let exitCode = 0;
  let signal = null;
  let executionError;
  const { stdout, stderr } = await checkedExecute(process.execPath, args, directory).catch(
    (error) => {
      exitCode = typeof error.code === 'number' ? error.code : null;
      signal = error.signal ?? null;
      executionError = error.message;
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  );

  await writeFile(join(directory, 'test-events.jsonl'), stdout);
  await writeFile(join(directory, 'test-stderr.log'), stderr);
  const records = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    ...summarizeWitnessEvents(records, exitCode, signal),
    exitCode,
    signal,
    executionError,
  };
}

async function run() {
  const { manifestSha256, companion } = parseWindowsWitnessArguments(
    process.argv.slice(2),
    process.arch
  );
  const target = WINDOWS_CUSTODY_TARGETS.find(({ architecture }) => architecture === process.arch);
  if (process.platform !== 'win32' || !target) {
    throw new Error('Windows native witness coverage requires an eligible Windows Node process');
  }
  const directory = await mkdtemp(join(await realpath(root), '.build-witness-'));
  const receipt = {
    platform: process.platform,
    node: process.version,
    nodeArchitecture: process.arch,
    windowsRelease: release(),
    manifestSha256,
    status: 'incomplete',
    logDirectory: pathToFileURL(directory + '/').href,
  };

  try {
    const { bytes, guardian, sources } = await readGuardianWitnessInputs(
      root,
      target.architecture,
      manifestSha256
    );
    const witnessGuardian = join(directory, 'windows-guardian-witness.exe');
    const fixturePath = join(directory, nativeFixture);
    await writeFile(witnessGuardian, bytes, { flag: 'wx' });
    receipt.guardian = guardian;
    if (companion) {
      const { artifact, identity } = await readPreparedArm64Companion(companion, guardian, sources);
      await writeFile(fixturePath, artifact, { flag: 'wx' });
      receipt.fixture = { ...identity, mode: 'prepared-companion' };
    } else {
      receipt.fixture = {
        ...(await compileOwnerWitness(directory, target, sources)),
        mode: 'local-build',
      };
    }

    if (
      windowsCustodySha256(await readOwnerWitnessArtifact(directory)) !==
      receipt.fixture.artifactSha256
    )
      throw new Error('The native witness fixture changed before the architecture probe');
    const { stdout, stderr } = await checkedExecute(
      fixturePath,
      ['--report-architecture'],
      directory
    ).catch(async (error) => {
      await writeFile(
        join(directory, 'architecture.log'),
        (error.stdout ?? '') + (error.stderr ?? '')
      );
      throw error;
    });
    await writeFile(join(directory, 'architecture.log'), stdout + stderr);
    receipt.architecture = readWitnessArchitecture(process.arch, process.versions.node, stdout);
    if (
      windowsCustodySha256(await readFile(witnessGuardian)) !== guardian.sha256 ||
      windowsCustodySha256(await readOwnerWitnessArtifact(directory)) !==
        receipt.fixture.artifactSha256
    )
      throw new Error('A Windows witness executable changed before test execution');
    receipt.tests = await recordTestRun(directory);
    if (!receipt.tests.passedAll)
      throw new Error('Windows native witness cases are incomplete or failing');
    receipt.status = 'passed';
  } catch (error) {
    receipt.error = error.message;
    process.exitCode = 1;
  }

  const output = JSON.stringify(receipt, null, 2) + '\n';
  await writeFile(join(directory, 'receipt.json'), output, { flag: 'wx' });
  process.stdout.write(output);
}

try {
  await run();
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
