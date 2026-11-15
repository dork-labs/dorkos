import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** CI-only macOS spec for the real native guest, before/during/after handoff and Stop. */
export async function assertEmbeddedBrowserHandoff(): Promise<string> {
  if (process.env.CI !== 'true' || process.platform !== 'darwin')
    throw new Error('The native guest proof runs only on a macOS CI runner.');
  const require = createRequire(import.meta.url);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'dorkos-native-browser-'));
  const home = path.join(scratch, 'home');
  await mkdir(home);
  try {
    const outfile = path.join(scratch, 'main.cjs');
    await build({
      entryPoints: [fileURLToPath(new URL('./local-browser-ci/fixture.ts', import.meta.url))],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      plugins: [
        {
          name: 'installed-playwright',
          setup(builder) {
            builder.onResolve({ filter: /^playwright-core$/ }, () => ({
              path: require.resolve('playwright-core'),
              external: true,
            }));
          },
        },
      ],
    });
    const { stdout } = await promisify(execFile)(
      require('electron') as string,
      [
        outfile,
        '--use-mock-keychain',
        '--password-store=basic',
        `--user-data-dir=${path.join(scratch, 'profile')}`,
      ],
      {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          CI: 'true',
          HOME: home,
          DORK_HOME: path.join(home, '.dork'),
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          DORKOS_TEST_RUNTIME: 'true',
        },
      }
    );
    return stdout.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
