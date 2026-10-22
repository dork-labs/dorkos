/* global URL */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { securityPathPattern, touchesSecurity } from './security-gate.mjs';

const reference = readFileSync(
  new URL('./fixtures/security-path-pattern.regex', import.meta.url),
  'utf8'
).trim();
const root = fileURLToPath(new URL('../../', import.meta.url));

test('gate pattern equals Security reference and the installed interim checker', () => {
  assert.equal(securityPathPattern(), reference, 'workflow differs from the approved reference');
  // The host-only interim checker is deliberately absent on CI. Its reviewed
  // snapshot above always runs; a local installation must also match directly.
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const interim = resolve(root, common, '..', '.temp/coord/security-paths-check.sh');
  if (existsSync(interim)) {
    const pattern = /^re='([^']+)'$/m.exec(readFileSync(interim, 'utf8'))?.[1];
    assert.ok(pattern, 'interim checker pattern missing');
    assert.equal(securityPathPattern(), pattern, 'workflow differs from the live interim checker');
  }
});

const additions = [
  ['package.json', 'package.jsonx'],
  ['apps/client/package.json', 'apps/client/package.jsonx'],
  ['packages/shared/package.json', 'packages/shared/packages.json'],
  ['pnpm-lock.yaml', 'pnpm-lock.yamlx'],
  ['pnpm-workspace.yaml', 'pnpm-workspaces.yaml'],
  [
    'apps/server/src/services/core/event-fan-out.ts',
    'apps/server/src/services/core/event-fanning-out.ts',
  ],
  [
    'apps/server/src/services/rooms/manage/room-membership.ts',
    'apps/server/src/services/rooms/manage/room-membership.tsx',
  ],
  [
    'apps/server/src/services/rooms/service/room-awaiting.ts',
    'apps/server/src/services/rooms/service/room-awaiting.tsx',
  ],
  [
    'apps/server/src/services/rooms/awaiting/room-awaiting.ts',
    'apps/server/src/services/rooms/awaitings/room-awaiting.ts',
  ],
  ['.agents/flow/config.json', '.agents/flower/config.json'],
  ['.dork/plugins/flow/config/local.json', '.dork/plugins/flow/configuration/local.json'],
];
for (const [match, miss] of additions) {
  test(`new trust path and rename: ${match}`, () => {
    assert.ok(touchesSecurity([{ filename: match }], reference));
    assert.ok(
      touchesSecurity([{ filename: 'docs/moved.md', previous_filename: match }], reference)
    );
    assert.equal(touchesSecurity([{ filename: miss }], reference), false, miss);
  });
}

test('both trusted gate workflows pin all actions to full commit SHAs', () => {
  for (const name of ['security-gate.yml', 'security-review-initialize.yml']) {
    const workflow = readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
    const uses = [...workflow.matchAll(/^\s*- uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
    assert.equal(uses.length, 2);
    for (const action of uses)
      assert.match(action, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/);
  }
});
