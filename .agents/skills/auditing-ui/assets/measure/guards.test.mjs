// DOR-3281: the measure leg never resolves Playwright from the current
// directory, and never measures the operator's own DorkOS on :4242.
// Run with: node --test .agents/skills/auditing-ui/assets/measure/guards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightRoots, refuseUrl } from './guards.mjs';

const here = '/repo/.agents/skills/auditing-ui/assets/measure';
const MEASURE = join(dirname(fileURLToPath(import.meta.url)), 'measure.mjs');

test('playwright roots never include the current directory', () => {
  const roots = playwrightRoots(undefined, here);
  assert.ok(!roots.includes(process.cwd()));
  assert.deepEqual(roots, [here, resolve(here, '../../../../../apps/e2e')]);
});

test('PLAYWRIGHT_FROM comes first when set', () => {
  assert.deepEqual(playwrightRoots('/opt/pw', here)[0], '/opt/pw');
});

for (const url of [
  'http://localhost:4242',
  'http://127.0.0.1:4242/settings',
  'http://[::1]:4242/',
  'http://0x7f000001:4242',
  'https://dorkos.local:4242',
  'https://LOCALHOST:4242',
]) {
  test(`refuses ${url}`, () => {
    assert.match(refuseUrl(url) ?? '', /4242/);
  });
}

for (const url of ['http://localhost:6241', 'http://127.0.0.1:5173/', 'https://preview.example.dev']) {
  test(`allows ${url}`, () => {
    assert.equal(refuseUrl(url), null);
  });
}

test('refuses what is not an http(s) URL', () => {
  assert.ok(refuseUrl('localhost:6241'));
  assert.ok(refuseUrl('file:///etc/passwd'));
});

test('a route can turn a safe base into :4242, so each base + route is checked', () => {
  assert.equal(refuseUrl('http://localhost'), null);
  assert.match(refuseUrl('http://localhost' + ':4242/') ?? '', /4242/);
});

test('measure.mjs exits 2 on :4242 before loading anything', () => {
  const r = spawnSync(process.execPath, [MEASURE, '--url', 'http://[::1]:4242'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /port 4242/);
});

test('a playwright-core planted in the current directory never runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-cwd-'));
  const marker = join(dir, 'RAN');
  const pkg = join(dir, 'node_modules', 'playwright-core');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"playwright-core","main":"index.js"}');
  writeFileSync(join(pkg, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); module.exports = {};`);
  try {
    const env = { ...process.env, CHROME_PATH: join(dir, 'no-such-chrome') };
    delete env.PLAYWRIGHT_FROM;
    spawnSync(process.execPath, [MEASURE, '--url', 'http://127.0.0.1:9', '--out', join(dir, 'out')], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(existsSync(marker), false, 'measure.mjs loaded playwright-core from cwd');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
