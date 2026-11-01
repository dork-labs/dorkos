/* global URL */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
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

test('the approval helper shows Dorian the same gate pattern', () => {
  const swift = readFileSync(resolve(root, 'tools/security-approve/Policy.swift'), 'utf8');
  const copy = /^let gatePathPattern = #"(.+)"#$/m.exec(swift)?.[1];
  assert.equal(copy, reference, 'tools/security-approve/Policy.swift gatePathPattern differs');
});

const additions = [
  ['packages/a/patches/b.patch', 'packages/a/patches-old/b.patch'],
  ['.node-version', '.node-versions'],
  ['apps/client/.node-version', 'apps/client/node-version'],
  ['CODEOWNERS', 'CODEOWNERS.md'],
  ['docs/CODEOWNERS', 'docs/CODEOWNERSx'],
  ['Codeowners', 'docs/codeowners-guide.md'],
  ['.NPMRC', '.NPMRC.backup'],
  ['.PNPMFILE.CJS', '.PNPMFILE.CJS.old'],
  ['PATCHES/dependency.patch', 'PATCHES-old/dependency.patch'],
  ['PNPM-LOCK.YAML', 'PNPM-LOCK.YAML.old'],
  ['Pnpm-Workspace.yaml', 'Pnpm-Workspaces.yaml'],
  ['.NVMRC', '.NVMRCx'],
  ['pacKage.json', 'pacKage.jsonx'],
  ['patcheſ/dependency.patch', 'patcheſ-old/dependency.patch'],
  ['.npmrc', '.npmrc.backup'],
  ['apps/client/.npmrc', 'apps/client/npmrc'],
  ['patches/dependency.patch', 'patches-old/dependency.patch'],
  ['packages/shared/patches/dependency.patch', 'packages/shared/patches-old/dependency.patch'],
  ['.pnpmfile.cjs', '.pnpmfile.cjs.old'],
  ['packages/shared/.pnpmfile.cjs', 'packages/shared/pnpmfile.cjs'],
  ['.nvmrc', '.nvmrcx'],
  ['apps/client/.nvmrc', 'apps/client/nvmrc'],
  ['PACKAGE.JSON', 'PACKAGE.JSONX'],
  ['apps/client/Package.Json', 'apps/client/Package.Jsonx'],
  ['packages/shared/pAcKaGe.JsOn', 'packages/shared/pAcKaGe.JsOnx'],
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
  // DOR-3366: #3223 changed the desktop main process and was called "no security paths".
  // Security gates the whole desktop app as one entry (#dorkos, 2026-10-27).
  ['apps/desktop/src/main/index.ts', 'apps/desktopx/src/main/index.ts'],
  ['apps/desktop/build/entitlements.mac.plist', 'apps/desktop-notes/build/entitlements.mac.plist'],
  ['apps/desktop/src/server-entry.ts', 'apps/client/src/server-entry.ts'],
  ['apps/desktop/electron-builder.yml', 'apps/desktop-notes/electron-builder.yml'],
  ['apps/desktop/scripts/build-server.ts', 'apps/desktopx/scripts/build-server.ts'],
  // S2 from Security's #3375 review: the design-token guard runs from the PR's own
  // code, so an edit that makes it always pass must wait for Security. Its tests stay
  // ungated: changing them alone cannot change what the guard decides.
  ['scripts/check-design-tokens.ts', 'scripts/check-design-tokens.test.ts'],
  ['scripts/design-tokens/rule-guard.ts', 'scripts/design-tokensx/rule-guard.ts'],
  ['scripts/design-tokens/fixtures/rules.json', 'scripts/__tests__/check-design-tokens.test.ts'],
];
for (const [match, miss] of additions) {
  test(`new trust path and rename: ${match}`, () => {
    assert.ok(touchesSecurity([{ filename: match }], reference));
    assert.ok(
      touchesSecurity([{ filename: 'docs/moved.md', previous_filename: match }], reference)
    );
    assert.equal(touchesSecurity([{ filename: miss }], reference), false, miss);
    // The coordinator uses POSIX ERE; keep its engine aligned with JavaScript.
    const shell = spawnSync('grep', ['-E', reference], {
      input: `${match.normalize('NFKC').toLowerCase()}\n${miss.normalize('NFKC').toLowerCase()}\n`,
      encoding: 'utf8',
    });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(shell.stdout, `${match.normalize('NFKC').toLowerCase()}\n`);
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

// Keep this fixture byte-for-byte aligned with marketplace S3b (PR #121).
const variantBytes = readFileSync(
  new URL('../../scripts/fixtures/security-path-variants.json', import.meta.url)
);
const variants = JSON.parse(variantBytes.toString('utf8'));
test('shared spelling fixture retains the pinned marketplace blob', () => {
  assert.equal(
    createHash('sha1').update(`blob ${variantBytes.length}\0`).update(variantBytes).digest('hex'),
    '32a042ddddc493f52f51883832b031c05f92a430'
  );
});
for (const path of variants.match) {
  test(`shared security spelling and rename: ${path}`, () => {
    assert.equal(touchesSecurity([{ filename: path }], reference), true);
    assert.equal(
      touchesSecurity([{ filename: 'docs/moved.md', previous_filename: path }], reference),
      true
    );
  });
}
for (const path of variants.noMatch) {
  test(`shared nonsecurity spelling: ${path}`, () => {
    assert.equal(touchesSecurity([{ filename: path }], reference), false);
  });
}
test('configured patterns are Unicode case-insensitive too', () => {
  const pattern = '^Private/SignIn\\.json$';
  assert.equal(touchesSecurity([{ filename: 'private/SIGNIN.json' }], pattern), true);
  assert.equal(
    touchesSecurity(
      [{ filename: 'docs/moved.md', previous_filename: 'PRIVATE/signin.json' }],
      pattern
    ),
    true
  );
  assert.equal(touchesSecurity([{ filename: 'private/signin.jsonx' }], pattern), false);
});
test('full folding adds sharp-s matches for configured patterns', () => {
  assert.equal(touchesSecurity([{ filename: 'private/Straße' }], '^private/strasse$'), true);
  assert.equal(touchesSecurity([{ filename: 'private/ẞ' }], '^private/ss$'), true);
});
test('normalization only adds matches and preserves regex syntax', () => {
  assert.equal(touchesSecurity([{ filename: 'name／literal' }], '^name／literal$'), true);
  assert.equal(touchesSecurity([{ filename: 'Private/File' }], '^Private/\\S+$'), true);
  assert.equal(touchesSecurity([{ filename: 'Private/ ' }], '^Private/\\S+$'), false);
});

for (const [pattern, path, miss] of [
  ['^(?!docs/)', 'DOCS/run.sh', 'docs/run.sh'],
  ['^[^a-z]', 'Secrets/a', 'secrets/a'],
  ['^(?!.*\\.md$)', 'README.MD', 'README.md'],
]) {
  test(`flagless match survives added folding: ${pattern}`, () => {
    assert.equal(new RegExp(pattern).test(path), true);
    assert.equal(new RegExp(pattern, 'iu').test(path), false);
    assert.equal(touchesSecurity([{ filename: path }], pattern), true);
    assert.equal(touchesSecurity([{ filename: miss, previous_filename: path }], pattern), true);
    assert.equal(touchesSecurity([{ filename: miss }], pattern), false);
  });
}
