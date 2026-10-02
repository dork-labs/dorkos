import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../runtime.mjs';

async function mockInstall({ missingExecutable = false, version = '1.63.0' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'browser-runtime-test-'));
  const executable = join(root, 'chromium-fixture');
  const files = {
    'apps/e2e/package.json': '{}',
    'apps/e2e/node_modules/@playwright/test/package.json': '{"main":"index.cjs"}',
    'apps/e2e/node_modules/@playwright/test/index.cjs': 'module.exports = {};',
    'apps/e2e/node_modules/playwright/package.json': '{"main":"index.cjs"}',
    'apps/e2e/node_modules/playwright/index.cjs': 'module.exports = {};',
    'apps/e2e/node_modules/playwright-core/package.json': JSON.stringify({
      version,
      main: 'index.cjs',
    }),
    'apps/e2e/node_modules/playwright-core/index.cjs': `module.exports = { chromium: { executablePath: () => ${JSON.stringify(executable)} } };`,
    'apps/e2e/node_modules/playwright-core/browsers.json':
      '{"browsers":[{"name":"chromium","revision":"1243"}]}',
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const contents = '#!/bin/sh\nexit 0\n';
  if (!missingExecutable) await writeFile(executable, contents, { mode: 0o700 });
  return { root, executable, hash: createHash('sha256').update(contents).digest('hex') };
}

test('installed runtime-1 hashes the executable it pins for headless launch', async () => {
  // Resolve through a real isolated package tree to test the e2e resolution boundary.
  const install = await mockInstall();
  try {
    const result = await loadPlaywright({ repoRoot: install.root });
    assert.equal(result.receipt.executablePath, install.executable);
    assert.equal(result.receipt.executableSha256, install.hash);
    assert.equal(result.receipt.libraryVersion, '1.63.0');
    assert.equal(result.receipt.chromiumRevision, '1243');
    assert.deepEqual(result.launchOptions, { executablePath: install.executable, headless: true });
  } finally {
    await rm(install.root, { recursive: true, force: true });
  }
});

test('runtime-1 missing executable and version mismatch refuse without starting or downloading', async () => {
  // There is no launch or download API in the fixtures: refusal must precede either operation.
  for (const [options, code] of [
    [{ missingExecutable: true }, 'EXECUTABLE_MISSING'],
    [{ version: '1.62.0' }, 'VERSION_MISMATCH'],
  ]) {
    const install = await mockInstall(options);
    try {
      await assert.rejects(
        loadPlaywright({ repoRoot: install.root }),
        (error) => error.code === code && !error.message.includes(install.root)
      );
    } finally {
      await rm(install.root, { recursive: true, force: true });
    }
  }
});

test('runtime-1 absent dependency reports an explicit install requirement', async () => {
  // An empty actual root is an observable missing-install subject, not a skipped test.
  const root = await mkdtemp(join(tmpdir(), 'browser-runtime-absent-'));
  try {
    await assert.rejects(loadPlaywright({ repoRoot: root }), { code: 'PLAYWRIGHT_MISSING' });
    await assert.rejects(loadPlaywright({ repoRoot: '.' }), TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime CLI through an alias emits its receipt or a nonzero unverified result', async () => {
  // A symlink/OS path alias must not silently skip the executable entry point.
  const install = await mockInstall();
  try {
    const alias = join(install.root, 'runtime-alias.mjs');
    await symlink(fileURLToPath(new URL('../runtime.mjs', import.meta.url)), alias);
    const success = await promisify(execFile)(process.execPath, [alias, install.root], {
      timeout: 5000,
    });
    const receipt = JSON.parse(success.stdout);
    assert.equal(receipt.kind, 'runtime');
    assert.equal(receipt.libraryVersion, '1.63.0');
    assert.equal(receipt.executablePath, '[local-only]');
    const absent = join(install.root, 'absent-install');
    await mkdir(absent);
    await assert.rejects(
      promisify(execFile)(process.execPath, [alias, absent], { timeout: 5000 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.killed, false);
        assert.deepEqual(JSON.parse(error.stderr), {
          status: 'unverified',
          code: 'PLAYWRIGHT_MISSING',
        });
        return true;
      }
    );
  } finally {
    await rm(install.root, { recursive: true, force: true });
  }
});
