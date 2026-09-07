import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scratchDirs: string[] = [];
const installScript = join(import.meta.dirname, '..', 'install.sh');

async function runInstaller(nodeVersion: string) {
  const scratch = await mkdtemp(join(tmpdir(), 'dorkos-install-node-'));
  scratchDirs.push(scratch);
  const fakeNode = join(scratch, 'node');
  const fakeNpm = join(scratch, 'npm');
  await writeFile(
    fakeNode,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v${nodeVersion}"; exit 0; fi\nexec "${process.execPath}" "$@"\n`
  );
  await writeFile(fakeNpm, '#!/bin/sh\necho "10.0.0"\n');
  await Promise.all([chmod(fakeNode, 0o755), chmod(fakeNpm, 0o755)]);

  return execFileAsync('/bin/bash', [installScript, '--dry-run'], {
    env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` },
  });
}

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('install script Node.js compatibility floor', () => {
  it.each(['22.21.9', '22.22.2'])('rejects unsupported Node.js %s', async (version) => {
    await expect(runInstaller(version)).rejects.toMatchObject({
      stderr: '',
      stdout: expect.stringContaining(`Node.js 22.22.3 or later is required`),
    });
  });

  it.each(['22.22.3', '24.14.1'])('accepts supported Node.js %s', async (version) => {
    await expect(runInstaller(version)).resolves.toMatchObject({
      stderr: '',
      stdout: expect.stringContaining(`[dry-run] Node.js v${version} ✓`),
    });
  });
});
