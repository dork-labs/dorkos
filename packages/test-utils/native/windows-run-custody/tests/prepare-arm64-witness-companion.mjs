/** Cross-build the maintained ARM64 companion on the already supported Windows build host. */
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import {
  arm64Target,
  companionManifestName,
  compileOwnerWitness,
  nativeFixture,
  prepareArm64CompanionManifest,
  readGuardianWitnessInputs,
  readOwnerWitnessArtifact,
} from './witness-companion.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function prepare() {
  const [option, guardianManifestSha256, ...rest] = process.argv.slice(2);
  if (
    option !== '--guardian-manifest-sha256' ||
    rest.length ||
    !/^[a-f0-9]{64}$/.test(guardianManifestSha256 ?? '')
  ) {
    throw new Error('Select the prepared ARM64 guardian with --guardian-manifest-sha256');
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('ARM64 witness preparation requires an x64 Node process on Windows');
  }

  const { guardian, sources } = await readGuardianWitnessInputs(
    root,
    'arm64',
    guardianManifestSha256
  );
  const scratch = await mkdtemp(join(await realpath(root), '.build-witness-arm64-'));
  try {
    const compiled = await compileOwnerWitness(scratch, arm64Target, sources);
    const artifact = await readOwnerWitnessArtifact(scratch);
    const { manifest, identity } = prepareArm64CompanionManifest({
      artifact,
      compiled,
      guardian,
      sources,
    });

    const handoff = join(scratch, 'handoff');
    await mkdir(handoff);
    await writeFile(join(handoff, nativeFixture), artifact, { flag: 'wx' });
    await writeFile(join(handoff, companionManifestName), manifest, { flag: 'wx' });
    process.stdout.write(
      JSON.stringify(
        {
          ...identity,
          guardianManifestSha256,
          buildPlatform: process.platform,
          buildNode: process.version,
          buildNodeArchitecture: process.arch,
          handoffDirectory: pathToFileURL(handoff + '/').href,
          buildLogDirectory: pathToFileURL(scratch + '/').href,
        },
        null,
        2
      ) + '\n'
    );
  } catch (error) {
    throw new Error(`ARM64 witness preparation failed. See ${scratch}\n${error.message}`, {
      cause: error,
    });
  }
}

try {
  await prepare();
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
