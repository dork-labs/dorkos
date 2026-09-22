import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function run(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stderr: string }>((resolvePromise, reject) => {
    const child = execFile(executable, args, { env: environment }, (error, _stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolvePromise({ code: typeof error?.code === 'number' ? error.code : 0, stderr });
    });
    child.once('error', reject);
  });
}

describe('credentialed live gate entrypoint', () => {
  it('refuses before npm, a profile, or any provider boundary when arms are absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dorkos-live-entrypoint-'));
    directories.push(directory);
    const marker = join(directory, 'npm-was-called');
    const npm = join(directory, 'npm');
    await writeFile(
      npm,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`,
      { mode: 0o700 }
    );
    await chmod(npm, 0o700);
    const script = resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts');
    const tsx = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const result = await run(process.execPath, [tsx, script], {
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      HOME: directory,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Community live gate is not armed');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The capture socket is opened mid-run and was closed only where the run
  // succeeded, so every throw after it opened leaked a listening server for the
  // life of the process. A real run needs both arms and a paid provider, so the
  // cheap guard is the shape of the code: opened into a binding declared
  // outside the try, and closed in the finally that already wipes the secret.
  it('closes the capture socket on every path out of the run', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const opens = [...source.matchAll(/await receiveClipboard\(/gu)];
    expect(opens).toHaveLength(1);
    expect(source).toMatch(/let clipboard: Awaited<ReturnType<typeof receiveClipboard>> \| null/u);
    expect(source).toMatch(/\(clipboard = await receiveClipboard\(/u);
    const finallyBlock = source.slice(source.lastIndexOf('} finally {'));
    expect(finallyBlock).toMatch(/await clipboard\?\.close\(\)/u);
  });
});
