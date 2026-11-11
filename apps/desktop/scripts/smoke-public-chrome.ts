/** CI-only entry: the child receives only an invented home and the host's executable search path. */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

async function main(): Promise<void> {
  if (process.env.CI !== 'true' || process.platform !== 'darwin')
    throw new Error('The public Chrome proof runs only on macOS CI.');
  const require = createRequire(import.meta.url);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'dorkos-public-chrome-'));
  const evidence = path.resolve('browser-proof-artifacts');
  const home = path.join(scratch, 'home');
  await mkdir(home);
  await mkdir(evidence, { recursive: true });
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        require.resolve('tsx'),
        fileURLToPath(new URL('./local-browser-ci/public-chrome.ts', import.meta.url)),
      ],
      {
        timeout: 360000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          DORK_HOME: path.join(home, '.dork'),
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          DORKOS_TEST_RUNTIME: 'true',
          CI: 'true',
          DORKOS_PUBLIC_CHROME_ARTIFACTS: evidence,
        },
      }
    );
    console.log(
      'Public Chrome proof passed. Screenshots and UA records are in browser-proof-artifacts.'
    );
  } catch (error) {
    // Browser launch errors include command lines. Keep those out of shared logs.
    const failure = error as { stderr?: string };
    const safe = (failure.stderr ?? '')
      .split('\n')
      .filter((line) => !line.includes('--') && !line.includes('Command failed:'))
      .slice(-20)
      .join('\n');
    await writeFile(path.join(evidence, 'failure.txt'), safe);
    throw new Error('Public Chrome proof did not pass. Inspect the browser proof artifacts.', {
      cause: error,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
