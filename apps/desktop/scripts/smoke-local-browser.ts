import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

const witness = (file: string) =>
  fileURLToPath(new URL(`./local-browser-ci/${file}`, import.meta.url));
const client = fileURLToPath(new URL('../../client', import.meta.url));
const desktop = fileURLToPath(new URL('..', import.meta.url));

/**
 * The app's own built stylesheet, from the renderer the job built before this ran:
 * the largest `index-*.css`, which is the app shell's (the others are lazy chunks).
 */
async function builtStylesheet(): Promise<string | null> {
  const assets = path.join(desktop, 'dist', 'renderer', 'assets');
  const names = (await readdir(assets).catch(() => [] as string[])).filter(
    (name) => name.startsWith('index-') && name.endsWith('.css')
  );
  const sized = await Promise.all(
    names.map(async (name) => ({ name, size: (await stat(path.join(assets, name))).size }))
  );
  const largest = sized.sort((a, b) => b.size - a.size)[0];
  return largest ? path.join(assets, largest.name) : null;
}

/** CI-only macOS spec for the real native guest: handoff and Stop, then app layers over it. */
export async function assertEmbeddedBrowserHandoff(): Promise<string> {
  if (process.env.CI !== 'true' || process.platform !== 'darwin')
    throw new Error('The native guest proof runs only on a macOS CI runner.');
  const require = createRequire(import.meta.url);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'dorkos-native-browser-'));
  const home = path.join(scratch, 'home');
  await mkdir(home);
  const installedPlaywright: Plugin = {
    name: 'installed-playwright',
    setup(builder) {
      builder.onResolve({ filter: /^playwright-core$/ }, () => ({
        path: require.resolve('playwright-core'),
        external: true,
      }));
    },
  };
  const mainProcess = async (entry: string) => {
    const outfile = path.join(scratch, `${path.basename(entry, '.ts')}.cjs`);
    await build({
      entryPoints: [witness(entry)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      plugins: [installedPlaywright],
    });
    return outfile;
  };
  const run = async (outfile: string, env: Record<string, string> = {}, timeout = 60_000) => {
    const { stdout } = await promisify(execFile)(
      require('electron') as string,
      [
        outfile,
        '--use-mock-keychain',
        '--password-store=basic',
        `--user-data-dir=${path.join(scratch, `profile-${path.basename(outfile, '.cjs')}`)}`,
      ],
      {
        timeout,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          CI: 'true',
          HOME: home,
          DORK_HOME: path.join(home, '.dork'),
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          DORKOS_TEST_RUNTIME: 'true',
          ...env,
        },
      }
    );
    return stdout.trim();
  };
  try {
    const handoff = await run(await mainProcess('fixture.ts'));

    // DOR-4417, DOR-4418: the client's real surface hook and shared layers, bundled
    // from the client's own modules, drive the same native bridge.
    const page = path.join(scratch, 'overlay-page.js');
    await build({
      entryPoints: [witness('overlay-page.tsx')],
      outfile: page,
      bundle: true,
      platform: 'browser',
      format: 'iife',
      tsconfig: path.join(client, 'tsconfig.json'),
      nodePaths: [path.join(client, 'node_modules')],
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const preload = path.join(scratch, 'overlay-preload.cjs');
    await build({
      entryPoints: [witness('overlay-preload.ts')],
      outfile: preload,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    const overlays = await run(await mainProcess('overlays.ts'), {
      DORKOS_OVERLAY_PAGE: page,
      DORKOS_OVERLAY_PRELOAD: preload,
    });

    // DOR-4427: the real browser chrome over the same native page. Its tooltips
    // wait, and open only onto a still; the frames go up with the browser proof.
    const chromePage = path.join(scratch, 'chrome-tooltip-page.js');
    await build({
      entryPoints: [witness('chrome-tooltip-page.tsx')],
      outfile: chromePage,
      bundle: true,
      platform: 'browser',
      format: 'iife',
      tsconfig: path.join(client, 'tsconfig.json'),
      nodePaths: [path.join(client, 'node_modules')],
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const stylesheet = await builtStylesheet();
    if (!stylesheet)
      console.warn('Chrome tooltips: no built stylesheet, so the frames are unstyled.');
    const tooltips = await run(
      await mainProcess('chrome-tooltips.ts'),
      {
        DORKOS_CHROME_PAGE: chromePage,
        DORKOS_OVERLAY_PRELOAD: preload,
        DORKOS_CHROME_PROOF_DIR: path.join(desktop, 'browser-proof-artifacts', 'chrome-tooltips'),
        ...(stylesheet ? { DORKOS_CHROME_CSS: stylesheet } : {}),
      },
      120_000
    );
    return `${handoff} ${overlays} ${tooltips}`;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
