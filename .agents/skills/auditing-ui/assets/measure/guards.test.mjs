// DOR-3281: the measure leg never resolves Playwright from the current
// directory, and never measures the operator's own DorkOS on :4242.
// Run with: node --test .agents/skills/auditing-ui/assets/measure/guards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { playwrightRoots, refuseUrl } from './guards.mjs';

const here = '/repo/.agents/skills/auditing-ui/assets/measure';

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
