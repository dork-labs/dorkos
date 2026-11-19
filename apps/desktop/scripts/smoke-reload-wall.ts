/** Launch the loopback browser witness only in CI, with an allowlisted, throwaway environment. */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

async function main(): Promise<void> {
  if (process.env.CI !== 'true' || process.platform !== 'darwin')
    throw new Error('The reload witness runs only on macOS CI.');
  const require = createRequire(import.meta.url);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'dorkos-reload-wall-'));
  const evidence = path.resolve('reload-wall-artifacts');
  const home = path.join(scratch, 'home');
  await mkdir(home);
  await mkdir(evidence, { recursive: true });
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        require.resolve('tsx'),
        fileURLToPath(new URL('./local-browser-ci/reload-wall.mts', import.meta.url)),
      ],
      {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          DORK_HOME: path.join(home, '.dork'),
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          DORKOS_TEST_RUNTIME: 'true',
          CI: 'true',
          DORKOS_LOCAL_BROWSER_ARTIFACTS: evidence,
        },
      }
    );
    console.log('Reload witness passed. The receipt is in reload-wall-artifacts.');
  } catch (error) {
    // Child launch failures may contain argv. Never copy those into shared logs.
    const safe = ((error as { stderr?: string }).stderr ?? '')
      .split('\n')
      .filter((line) => !line.includes('--') && !line.includes('Command failed:'))
      .slice(-20)
      .join('\n');
    await writeFile(path.join(evidence, 'failure.txt'), safe);
    throw new Error('Reload witness did not pass. Inspect its artifacts.', { cause: error });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Reload witness did not run.');
  process.exitCode = 1;
});
