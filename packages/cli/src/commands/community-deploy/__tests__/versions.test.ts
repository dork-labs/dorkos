import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderCommandError } from '../provider-process.js';
import {
  assertCommunityCliVersions,
  classifyCommunityProviderPreflightFailure,
  CommunityCliVersionError,
  CommunityProviderPreflightError,
} from '../runtime/versions.js';

describe('Community provider preflight guidance', () => {
  it('maps a missing executable to its official installation path', () => {
    expect(() =>
      classifyCommunityProviderPreflightFailure('fly', new ProviderCommandError('SPAWN'))
    ).toThrowError(new CommunityProviderPreflightError('fly', 'CLI_NOT_FOUND'));
    expect(() =>
      classifyCommunityProviderPreflightFailure('neon', new ProviderCommandError('SPAWN'))
    ).toThrow('https://neon.com/docs/reference/neon-cli');
  });

  it('keeps ambiguous command exits unavailable instead of claiming authentication failed', () => {
    expect(() =>
      classifyCommunityProviderPreflightFailure('fly', new ProviderCommandError('EXIT'))
    ).toThrowError(new CommunityProviderPreflightError('fly', 'PROVIDER_UNAVAILABLE'));
    expect(() =>
      classifyCommunityProviderPreflightFailure('neon', new ProviderCommandError('EXIT'))
    ).toThrow('Check provider status, CLI compatibility, and sign-in with neonctl auth');
  });

  it('links old-version failures to the official update instructions', () => {
    expect(new CommunityCliVersionError('fly').message).toContain(
      'https://fly.io/docs/flyctl/install/'
    );
    expect(new CommunityCliVersionError('neonctl').message).toContain(
      'https://neon.com/docs/reference/neon-cli'
    );
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fakeCli(output: string): Promise<{
  executable: string;
  env: Record<string, string>;
  timeoutMs: number;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-cli-version-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'cli');
  await writeFile(executable, `#!/bin/sh\nprintf '%s' '${output}'\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, env: {}, timeoutMs: 10_000 };
}

describe('assertCommunityCliVersions', () => {
  // flyctl reports the running executable's base name. It ships as `flyctl` with a `fly` link, and
  // Linux resolves the link, so a correct install there reports `flyctl`.
  it.each(['fly', 'flyctl', 'fly.exe', 'flyctl.exe'])(
    'accepts a Fly CLI named %s',
    async (name) => {
      await expect(
        assertCommunityCliVersions(
          await fakeCli(`{"Name":"${name}","Version":"0.4.104","OS":"linux"}`),
          await fakeCli('6.3.0\n'),
          { fly: '0.4.104', neon: '5.0.0' }
        )
      ).resolves.toBeUndefined();
    }
  );

  it('refuses a version report from some other program', async () => {
    await expect(
      assertCommunityCliVersions(
        await fakeCli('{"Name":"other","Version":"0.4.104"}'),
        await fakeCli('6.3.0'),
        { fly: '0.4.104', neon: '5.0.0' }
      )
    ).rejects.toMatchObject({ provider: 'fly', code: 'PROVIDER_UNAVAILABLE' });
  });
});
