/**
 * @vitest-environment node
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readFlySecretInventory,
  readFlySessionCredential,
  verifyTigrisSecretNames,
} from '../tigris-session.js';

const temporaryDirectories: string[] = [];

async function fakeFlyctl(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-fake-flyctl-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'fly');
  await writeFile(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const processOptions = (executable: string) => ({ executable, env: {}, timeoutMs: 1_000 });

describe('Tigris local Fly session boundary', () => {
  it('uses only the pinned machine-readable token command and redacts the credential wrapper', async () => {
    const canary = 'CANARY_FLY_SESSION_TOKEN';
    const executable = await fakeFlyctl(`
test "$1 $2 $3 $4" = "auth token --json --quiet" || exit 9
printf '{"token":"${canary}"}'
`);

    const credential = await readFlySessionCredential(processOptions(executable));
    await expect(credential.use(async (token) => token === canary)).resolves.toBe(true);
    expect(String(credential)).not.toContain(canary);
    expect(JSON.stringify(credential)).not.toContain(canary);
    credential.dispose();
    await expect(credential.use(async () => true)).rejects.toMatchObject({
      code: 'CREDENTIAL_DISPOSED',
      message: expect.not.stringContaining(canary),
    });
  });

  it('reads structured non-secret inventory and proves both Tigris names', async () => {
    const executable = await fakeFlyctl(`
test "$1 $2 $3 $4 $5" = "secrets list --app community-app --json" || exit 9
printf '[{"name":"AWS_SECRET_ACCESS_KEY","digest":"sha256:secret","status":"Staged"},{"name":"Other_Secret","digest":"sha256:other","status":"Deployed"},{"name":"AWS_ACCESS_KEY_ID","digest":"sha256:access","status":"Staged"}]'
`);

    const inventory = await readFlySecretInventory(processOptions(executable), 'community-app');
    expect(verifyTigrisSecretNames(inventory).map((item) => item.name)).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
    ]);
  });

  it('fails closed on malformed, duplicate, missing, and unsafe inventory', async () => {
    const duplicate = await fakeFlyctl(`
printf '[{"name":"AWS_ACCESS_KEY_ID","digest":"sha256:a"},{"name":"AWS_ACCESS_KEY_ID","digest":"sha256:b"}]'
`);
    await expect(
      readFlySecretInventory(processOptions(duplicate), 'community-app')
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    expect(() => verifyTigrisSecretNames([])).toThrowError(
      expect.objectContaining({ code: 'MISSING_TIGRIS_SECRETS' })
    );
    await expect(
      readFlySecretInventory(processOptions(duplicate), 'unsafe/app')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never copies a malformed token or provider output into an error', async () => {
    const canary = 'CANARY_MALFORMED_TOKEN\nSECRET';
    const executable = await fakeFlyctl(`printf '%s' '${canary}'`);

    await expect(readFlySessionCredential(processOptions(executable))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.not.stringContaining(canary),
    });
  });
});
