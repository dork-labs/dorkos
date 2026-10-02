import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readdir, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const child = fileURLToPath(new URL('./install-probe-child.mjs', import.meta.url));

/** Run a fresh cache-resolution subprocess and retain only fixed refusal codes or validated receipt data. */
export async function cacheAttempt({
  repoRoot,
  cacheDir,
  profilesDir,
  fixtureOrigin,
  launch = false,
}) {
  try {
    const { stdout } = await execute(
      process.execPath,
      [child, repoRoot, launch ? 'launch' : 'resolve', profilesDir ?? '', fixtureOrigin ?? ''],
      {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cacheDir },
        timeout: 20_000,
        maxBuffer: 64 * 1024,
      }
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout) return JSON.parse(error.stdout);
    throw Error('CACHE_SUBPROCESS_UNAVAILABLE', { cause: error });
  }
}

/** An absent executable must refuse without populating a private cache or downloading during an action. */
export async function missingInstallControl({ repoRoot, cacheDir, profilesDir, fixtureOrigin }) {
  await mkdir(cacheDir, { mode: 0o700 });
  const before = await readdir(cacheDir);
  assert.deepEqual(before, [], 'missing-install subject is an empty cache');
  const result = await cacheAttempt({
    repoRoot,
    cacheDir,
    profilesDir,
    fixtureOrigin,
    launch: true,
  });
  assert.equal(result.status, 'unverified');
  assert.equal(result.code, 'EXECUTABLE_MISSING');
  assert.deepEqual(await readdir(cacheDir), before, 'action cannot download into missing cache');
  return { samples: 1 };
}

/** Explicitly install the official lockfile-pinned full Chromium in a fresh private cache, never implicitly. */
export async function coldInstall({
  repoRoot,
  cacheDir,
  profilesDir,
  fixtureOrigin,
  install = false,
}) {
  assert.equal(install, true, 'explicit install authorization required');
  await mkdir(cacheDir, { mode: 0o700 });
  assert.deepEqual(await readdir(cacheDir), [], 'cold install requires an empty cache');
  const requireE2e = createRequire(join(repoRoot, 'apps/e2e/package.json'));
  const requireTest = createRequire(requireE2e.resolve('@playwright/test'));
  const cli = join(
    dirname(
      createRequire(requireTest.resolve('playwright')).resolve('playwright-core/package.json')
    ),
    'cli.js'
  );
  const start = performance.now();
  await execute(process.execPath, [cli, 'install', 'chromium', '--no-shell', '--no-remove'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cacheDir },
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => {
    throw Error('EXPLICIT_INSTALL_UNAVAILABLE');
  });
  const installMs = performance.now() - start;
  const result = await cacheAttempt({
    repoRoot,
    cacheDir,
    profilesDir,
    fixtureOrigin,
    launch: true,
  });
  assert.equal(result.status, 'pass', 'explicitly installed executable must launch');
  assert.ok(result.subjects.length > 0);
  return { ...result, installMs, samples: 1 };
}
