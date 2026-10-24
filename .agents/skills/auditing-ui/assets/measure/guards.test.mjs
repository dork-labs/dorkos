// measure.mjs never measures the operator's own DorkOS (:4242, in any host spelling) and never
// loads Playwright from the current directory (DOR-3281). No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { playwrightRoots, refuseOperatorUrl } from './guards.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MEASURE = join(here, 'measure.mjs');

for (const url of [
  'http://localhost:4242',
  'http://127.0.0.1:4242/settings',
  'http://[::1]:4242',
  'http://0x7f000001:4242',
  'http://dc-mbp.local:4242/',
  'https://LOCALHOST:4242',
]) {
  test(`refuses ${url}`, () => {
    assert.match(refuseOperatorUrl(url) ?? '', /refusing .*4242/);
  });
}

for (const url of ['http://localhost:6311', 'http://127.0.0.1:42420', 'http://localhost']) {
  test(`allows ${url}`, () => {
    assert.equal(refuseOperatorUrl(url), null);
  });
}

test('an unparseable --url is refused', () => {
  assert.match(refuseOperatorUrl('localhost:4242') ?? '', /must start with http/);
  assert.match(refuseOperatorUrl('file:///etc/passwd') ?? '', /must start with http/);
  assert.match(refuseOperatorUrl('not a url') ?? '', /not a valid URL/);
});

test('measure.mjs exits 2 on :4242 before loading anything', () => {
  const r = spawnSync(process.execPath, [MEASURE, '--url', 'http://[::1]:4242'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing/);
});

test('Playwright roots never include the current directory', () => {
  const roots = playwrightRoots({ env: {}, here });
  assert.ok(!roots.includes(process.cwd()) || process.cwd() === here);
  assert.equal(roots[0], here);
  assert.equal(playwrightRoots({ env: { PLAYWRIGHT_FROM: '/x' }, here })[0], '/x');
});

test('a playwright-core planted in the current directory never runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-cwd-'));
  const marker = join(dir, 'RAN');
  const pkg = join(dir, 'node_modules', 'playwright-core');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"playwright-core","main":"index.js"}');
  writeFileSync(
    join(pkg, 'index.js'),
    `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); module.exports = {};`
  );
  try {
    const env = { ...process.env, CHROME_PATH: join(dir, 'no-such-chrome') };
    delete env.PLAYWRIGHT_FROM;
    spawnSync(
      process.execPath,
      [MEASURE, '--url', 'http://127.0.0.1:9', '--out', join(dir, 'out')],
      { cwd: dir, env, encoding: 'utf8', timeout: 30_000 }
    );
    assert.equal(existsSync(marker), false, 'measure.mjs loaded playwright-core from cwd');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
