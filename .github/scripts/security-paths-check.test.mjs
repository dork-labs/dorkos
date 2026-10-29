import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPaths } from '../../scripts/security-paths-check.mjs';
import { securityPathPattern, touchesSecurity } from './security-gate.mjs';
const pairs = [
  [
    'apps/server/src/services/runtimes/claude-code/tool-gate/x.ts',
    'apps/server/src/services/runtimes/claude-code/tool-gatex/x.ts',
  ],
  [
    'apps/server/src/services/runtimes/claude-code/turn-permission.ts',
    'apps/server/src/services/runtimes/claude-code/turn-permissionx.ts',
  ],
  [
    'apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts',
    'apps/server/src/services/runtimes/claude-code/messaging/interactive-handlersx.ts',
  ],
  [
    'apps/server/src/services/runtimes/claude-code/messaging/launch-resolver.ts',
    'apps/server/src/services/runtimes/claude-code/messaging/launch-resolverx.ts',
  ],
  [
    'apps/server/src/services/runtimes/claude-code/messaging/permission-mode-guard.ts',
    'apps/server/src/services/runtimes/claude-code/messaging/permission-mode-guardx.ts',
  ],
  [
    'apps/server/src/services/runtimes/claude-code/mcp-tools/session-start-permission.ts',
    'apps/server/src/services/runtimes/claude-code/mcp-tools/session-start-permissionx.ts',
  ],
  [
    'apps/server/src/services/runtimes/shared/permission-tool-filter.ts',
    'apps/server/src/services/runtimes/shared/permission-tool-filterx.ts',
  ],
  [
    'apps/server/src/services/runtimes/shared/approval-verdict-block.ts',
    'apps/server/src/services/runtimes/shared/approval-verdict-blockx.ts',
  ],
  [
    'apps/server/src/services/runtimes/opencode/messaging/approvals.ts',
    'apps/server/src/services/runtimes/opencode/messaging/approvalsx.ts',
  ],
  [
    'apps/server/src/services/runtimes/doe/approvals.ts',
    'apps/server/src/services/runtimes/doe/approvalsx.ts',
  ],
  ['apps/server/src/services/spaces/x.ts', 'apps/server/src/services/spacesx/x.ts'],
  ['apps/server/src/services/identity/x.ts', 'apps/server/src/services/identityx/x.ts'],
  ['apps/server/src/services/computers/x.ts', 'apps/server/src/services/computersx/x.ts'],
  ['apps/server/src/services/rooms/limits/x.ts', 'apps/server/src/services/rooms/limitsx/x.ts'],
  ['apps/server/src/services/rooms/repo/x.ts', 'apps/server/src/services/rooms/repox/x.ts'],
  [
    'apps/server/src/services/rooms/turn-guards/x.ts',
    'apps/server/src/services/rooms/turn-guardsx/x.ts',
  ],
  [
    'apps/server/src/services/rooms/session-bindings/x.ts',
    'apps/server/src/services/rooms/session-bindingsx/x.ts',
  ],
  ['apps/server/src/services/session/origin/x.ts', 'apps/server/src/services/session/originx/x.ts'],
  [
    'apps/server/src/services/session/chat-messages/x.ts',
    'apps/server/src/services/session/chat-messagesx/x.ts',
  ],
  [
    'apps/server/src/services/session/turn-identity/x.ts',
    'apps/server/src/services/session/turn-identityx/x.ts',
  ],
  ['packages/shared/src/permissions/x.ts', 'packages/shared/src/permissionsx/x.ts'],
  ['packages/shared/src/permission-semantics.ts', 'packages/shared/src/permission-semanticsx.ts'],
  ['packages/shared/src/config-permissions.ts', 'packages/shared/src/config-permissionsx.ts'],
  ['packages/shared/src/agent-browser.ts', 'packages/shared/src/agent-browserx.ts'],
  ['packages/shared/src/agent-runtime.ts', 'packages/shared/src/agent-runtimex.ts'],
  ['packages/shared/src/untrusted-text.ts', 'packages/shared/src/untrusted-textx.ts'],
  ['packages/shared/src/approval-schemas.ts', 'packages/shared/src/approval-schemasx.ts'],
  [
    'packages/shared/src/extension-approval-schemas.ts',
    'packages/shared/src/extension-approval-schemasx.ts',
  ],
  ['packages/shared/src/cloud-origin.ts', 'packages/shared/src/cloud-originx.ts'],
  ['apps/desktop/src/preload/index.ts', 'apps/desktopx/src/preload/index.ts'],
  ['apps/server/src/services/core/approvals/x.ts', 'apps/server/src/services/core/approvalsx/x.ts'],
  [
    'apps/server/src/services/core/mcp-tool-gate.ts',
    'apps/server/src/services/core/mcp-tool-gatex.ts',
  ],
  ['apps/server/src/lib/trusted-origins.ts', 'apps/server/src/lib/trusted-originsx.ts'],
  [
    'apps/server/src/services/communities/remote/pinned-origin.ts',
    'apps/server/src/services/communities/remotex/x.ts',
  ],
  ['apps/server/src/env.ts', 'apps/server/src/envx.ts'],
  ['apps/server/src/index.ts', 'apps/server/src/indexer.ts'],
  ['apps/server/src/lib/process/network-fault.ts', 'apps/server/src/lib/processx/x.ts'],
  ...['relay', 'mesh', 'a2a-gateway', 'extension-api', 'connector-providers', 'cloud-api'].map(
    (p) => [`packages/${p}/x.ts`, `packages/${p}x/x.ts`]
  ),
  ['scripts/security-paths-check.mjs', 'scripts/other-security-paths-check.mjs'],
  ['tools/security-approve/main.swift', 'tools/security-approver/x'],
];
for (const [match, miss] of pairs)
  test(`path boundary: ${match}`, () => {
    assert.equal(touchesSecurity([{ filename: match }], securityPathPattern()), true);
    assert.equal(touchesSecurity([{ filename: miss }], securityPathPattern()), false);
    assert.equal(
      touchesSecurity(
        [{ filename: 'docs/moved.md', previous_filename: match }],
        securityPathPattern()
      ),
      true
    );
  });
function fixture(files, labels = []) {
  const head = 'a'.repeat(40);
  const pr = {
    headRefOid: head,
    baseRefName: 'main',
    baseRefOid: 'c'.repeat(40),
    labels: labels.map((name) => ({ name })),
    changedFiles: files.length,
  };
  const outputs = [];
  const responses = [pr, [files], pr];
  return {
    outputs,
    responses,
    deps: { out: (s) => outputs.push(s), run: () => JSON.stringify(responses.shift()) },
  };
}
test('clear exits 0; matches refuse with or without label and print head/files', () => {
  const f = fixture([{ filename: 'docs/a.md' }]);
  assert.equal(checkPaths('3167', f.deps), 0);
  for (const labels of [[], ['security-reviewed']]) {
    const g = fixture([{ filename: 'apps/server/src/index.ts' }], labels);
    assert.equal(checkPaths('3167', g.deps), 1);
    assert.match(g.outputs.join('\n'), /a{40}/);
    assert.match(g.outputs.join('\n'), /index.ts/);
  }
});
test('renames, moved heads, incomplete listings and API errors fail closed', () => {
  const f = fixture([
    { filename: 'docs/a.md', previous_filename: 'tools/security-approve/main.swift' },
  ]);
  assert.equal(checkPaths('3167', f.deps), 1);
  const moved = fixture([]);
  moved.responses[2] = { headRefOid: 'b'.repeat(40) };
  assert.throws(() => checkPaths('3167', moved.deps), /moved/);
  const truncated = fixture([{ filename: 'docs/a.md' }]);
  truncated.responses[1] = [[]];
  assert.throws(() => checkPaths('3167', truncated.deps), /Incomplete/);
  assert.throws(
    () =>
      checkPaths('3167', {
        run: () => {
          throw new Error('API failed');
        },
      }),
    /API failed/
  );
  assert.throws(() => checkPaths('bad'), /Usage/);
});

test('same-head retarget refuses a stale nonsensitive file list', () => {
  for (const patch of [{ baseRefName: 'other' }, { baseRefOid: 'd'.repeat(40) }]) {
    const f = fixture([{ filename: 'docs/a.md' }]);
    f.responses[2] = { ...f.responses[2], ...patch };
    assert.throws(() => checkPaths('3167', f.deps), /base moved/);
  }
});
