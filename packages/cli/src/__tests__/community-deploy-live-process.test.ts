/** @vitest-environment node */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommunityLiveGateError } from '../../scripts/community-deploy-live-capture.js';
import {
  parsePublishedVersion,
  runCommunityLiveGateCommand,
} from '../../scripts/community-deploy-live-process.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

/** A stand-in `npm` that prints the given shell body. */
async function fakeNpm(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-live-process-'));
  directories.push(directory);
  const executable = join(directory, 'npm');
  await writeFile(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

/** What npm prints on stderr when it inherits pnpm's npm_config_* environment. */
const NPM_UNDER_PNPM_WARNING =
  'npm warn Unknown env config "verify-deps-before-run". This will stop working in the next major version of npm.';

async function readPublished(executable: string): Promise<unknown> {
  return parsePublishedVersion(
    await runCommunityLiveGateCommand(
      executable,
      ['view', 'dorkos@0.81.0', 'version', '--json'],
      {},
      'published-version'
    )
  );
}

describe('community live gate commands', () => {
  it('reads the published version from stdout while npm warns on stderr', async () => {
    const npm = await fakeNpm(`
printf '%s\\n' '${NPM_UNDER_PNPM_WARNING}' >&2
printf '%s\\n' '"0.81.0"'
printf '%s\\n' '${NPM_UNDER_PNPM_WARNING}' >&2
`);
    await expect(readPublished(npm)).resolves.toBe('0.81.0');
  });

  it('names the published-version step when stdout is not JSON', async () => {
    for (const stdout of ['', 'npm warn something', '"0.81.0']) {
      const npm = await fakeNpm(`printf '%s' '${stdout}'`);
      const failure = await readPublished(npm).catch((error: unknown) => error);
      expect(failure, stdout).toBeInstanceOf(CommunityLiveGateError);
      expect(failure, stdout).toMatchObject({ step: 'published-version' });
    }
  });

  it('names the step when the command exits non-zero, whatever it printed', async () => {
    const npm = await fakeNpm(`printf '%s' '"0.81.0"'; exit 1`);
    await expect(readPublished(npm)).rejects.toMatchObject({ step: 'published-version' });
  });
});
