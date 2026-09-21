/**
 * @vitest-environment node
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderCommandError, runProviderCommand } from '../provider-process.js';

const fixtureSchema = z
  .object({
    id: z.string().min(1),
    organizationId: z.string().min(1),
  })
  .strict();

function nodeFixture(
  source: string,
  overrides: Partial<{ timeoutMs: number; maxBytes: number }> = {}
) {
  return runProviderCommand({
    executable: process.execPath,
    args: ['-e', source],
    env: {},
    timeoutMs: overrides.timeoutMs ?? 2_000,
    maxBytes: overrides.maxBytes,
    parse: (stdout) => fixtureSchema.parse(JSON.parse(stdout)),
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Provider fixture did not become ready');
}

describe('provider process boundary', () => {
  it('returns only the sanitized parsed value', async () => {
    const result = await nodeFixture(
      `process.stdout.write(JSON.stringify({id:'app_1',organizationId:'org_1'}));`
    );
    expect(result).toEqual({ value: { id: 'app_1', organizationId: 'org_1' } });
  });

  it('does not disclose raw stdout or stderr when the command fails', async () => {
    const canary = 'CANARY_PROVIDER_SECRET';
    await expect(
      nodeFixture(
        `process.stdout.write('${canary}');process.stderr.write('${canary}');process.exit(7);`
      )
    ).rejects.toMatchObject({ code: 'EXIT', message: expect.not.stringContaining(canary) });
  });

  it('rejects malformed success without returning the raw response', async () => {
    const canary = 'CANARY_MALFORMED_SECRET';
    await expect(nodeFixture(`process.stdout.write('${canary}');`)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.not.stringContaining(canary),
    });
  });

  it('bounds time and output independently', async () => {
    await expect(
      nodeFixture(`setTimeout(() => {}, 5000);`, { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(
      nodeFixture(`process.stdout.write('x'.repeat(200));`, { maxBytes: 100 })
    ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });

  it('does not return from a timeout while the exact provider process can still mutate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dorkos-provider-timeout-'));
    const ready = join(directory, 'ready');
    const marker = join(directory, 'late-side-effect');
    try {
      const command = nodeFixture(
        `const {writeFileSync}=require('node:fs');process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(marker)},'late');process.exit(0)},500));writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`,
        { timeoutMs: 1_000 }
      );
      await waitForFile(ready);
      await expect(command).rejects.toMatchObject({ code: 'TIMEOUT' });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('turns an early stdin close into a safe error without an uncaught event or disclosure', async () => {
    const canary = `CANARY_STDIN_SECRET_${'x'.repeat(8 * 1024 * 1024)}`;
    let uncaught: Error | undefined;
    const onUncaught = (error: Error): void => {
      uncaught = error;
    };
    process.once('uncaughtException', onUncaught);
    try {
      await expect(
        runProviderCommand({
          executable: process.execPath,
          args: ['-e', `process.stdin.destroy();setTimeout(()=>{},1000);`],
          env: {},
          timeoutMs: 2_000,
          stdin: canary,
          parse: () => ({ ok: true }),
        })
      ).rejects.toMatchObject({ code: 'EXIT', message: expect.not.stringContaining(canary) });
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toBeUndefined();
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  it('reports spawn failure without copying the executable or arguments into the error', async () => {
    const canary = 'CANARY_ARG_SECRET';
    await expect(
      runProviderCommand({
        executable: '/definitely/missing-provider-command',
        args: [canary],
        env: {},
        timeoutMs: 100,
        parse: () => ({ ok: true }),
      })
    ).rejects.toEqual(expect.any(ProviderCommandError));
  });
});
