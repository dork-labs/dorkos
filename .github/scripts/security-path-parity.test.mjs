/* global URL */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { securityDeepPathPattern, securityPathPattern, touchesSecurity } from './security-gate.mjs';

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
  // Everything under ci/security/ is Security's (the review lens, the signers file
  // pr-gates trusts, the findings recipients, anything added later), and so are
  // pr-gates' check script and the findings script. Their fixtures stay ungated.
  ['ci/security/review-lens.md', 'ci/securityx.md'],
  ['ci/security/allowed_signers', 'ci/security-gate-promotion.md'],
  ['ci/security/findings-recipients.txt', 'docs/ci/security/findings-recipients.txt'],
  ['ci/security/x.txt', 'ci/securityx/x.txt'],
  ['scripts/pr-gates-check.sh', 'scripts/test-pr-gates-check.sh'],
  ['scripts/security-findings.sh', 'scripts/test-security-findings.sh'],
  // queue-reentry turns auto-merge back on with a write token (#4273), like queue-repeat-guard.
  ['scripts/queue-reentry.sh', 'scripts/test-queue-reentry.sh'],
  // DOR-4972: the work graph's reads decide what a reader sees of a chat, the claim
  // service writes their history, `namesPerson` in the registry is the owner rule, the
  // composition root wires the claim recorder, and the shared shapes say what a reader gets.
  [
    'apps/server/src/services/work-graph/reads/work-item-chats.ts',
    'apps/server/src/services/work-graphs/a.ts',
  ],
  [
    'apps/server/src/services/session/claims/work-claim-service.ts',
    'apps/server/src/services/session/claimsx/a.ts',
  ],
  [
    'apps/server/src/services/core/self-description/dorkos-registry.ts',
    'apps/server/src/services/core/self-description/dorkos-registry-docs.ts',
  ],
  [
    'apps/server/src/startup/steps/work-graph.ts',
    'apps/server/src/startup/steps/work-graph-links.ts',
  ],
  ['packages/shared/src/work-graph-reads.ts', 'packages/shared/src/work-graph-reads-old.ts'],
  ['packages/shared/src/wire/features.ts', 'packages/shared/src/wired/features.ts'],
  ['packages/shared/src/session-relay.ts', 'packages/shared/src/session-relay-link.ts'],
  [
    'packages/shared/src/session-relay-agent-computer.ts',
    'packages/shared/src/session-relay-agent-computers.ts',
  ],
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

// DOR-3678: core/operator is where agents' permissions are written (config_patch,
// update_agent_boundaries, the write policies, guarded paths, operator-only rules), so
// it is a security path and a P0 one. Each match is a real file; each miss stays out.
for (const [match, miss] of [
  [
    'apps/server/src/services/core/operator/config-patch.ts',
    'apps/server/src/services/core/operators/config-patch.ts',
  ],
  [
    'apps/server/src/services/core/operator/agent-write-policy.ts',
    'apps/server/src/services/core/operator-notes/agent-write-policy.ts',
  ],
  [
    'apps/server/src/services/core/operator/guarded-paths.ts',
    'apps/server/src/services/operator/guarded-paths.ts',
  ],
  [
    'apps/server/src/services/core/operator/operator-only-refusal.ts',
    'apps/client/src/services/core/operator/operator-only-refusal.ts',
  ],
]) {
  test(`core/operator is on both lists: ${match}`, () => {
    assert.ok(existsSync(resolve(root, match)), `${match} no longer exists`);
    const deep = securityDeepPathPattern();
    for (const pattern of [reference, deep]) {
      assert.ok(
        touchesSecurity([{ filename: match }], pattern),
        pattern === deep ? 'deep' : 'main'
      );
      assert.ok(
        touchesSecurity([{ filename: 'docs/moved.md', previous_filename: match }], pattern)
      );
      assert.equal(touchesSecurity([{ filename: miss }], pattern), false, miss);
    }
  });
}

// DOR-3678: the other server folders no pattern matched, as Security ruled them
// (#dorkos, 2026-11-02 17:25Z). `deep` is whether the folder is also a P0 path. Each
// match is a real file; its look-alike stays off both lists.
const S = 'apps/server/src/services';
for (const [match, miss, deep] of [
  [`${S}/core/lan-access/lan-trust.ts`, `${S}/core/lan-accessx/lan-trust.ts`, true],
  [`${S}/core/hub/hub-sign-in.ts`, `${S}/core/hubs/hub-sign-in.ts`, true],
  [`${S}/core/server-role/role-checks.ts`, `${S}/core/server-roles/role-checks.ts`, true],
  [`${S}/core/safe-defaults/default-verdicts.ts`, `${S}/safe-defaults/default-verdicts.ts`, true],
  [`${S}/core/remote/command-dispatcher.ts`, `${S}/core/remote-notes/command-dispatcher.ts`, true],
  [`${S}/terminal/terminal-manager.ts`, `${S}/terminals/terminal-manager.ts`, true],
  [`${S}/core/config/backups.ts`, `${S}/core/configs/backups.ts`, true],
  [`${S}/core/secret-file-scan/scan-folder.ts`, `${S}/core/secret-file-scans/scan-folder.ts`, true],
  [`${S}/core/hub-relay/link-codes.ts`, `${S}/core/hub-relays/link-codes.ts`, false],
  [`${S}/core/cloud/credits-inference.ts`, `${S}/core/cloudy/credits-inference.ts`, false],
  [`${S}/core/sign-in-landing/sign-in-landings.ts`, `${S}/core/sign-in-landings/x.ts`, false],
  [`${S}/memory/registry.ts`, `${S}/memoryx/registry.ts`, false],
  [`${S}/marketplace/package-fetcher.ts`, `${S}/marketplaces/package-fetcher.ts`, false],
  [`${S}/marketplace-mcp/tool-install.ts`, `${S}/marketplace-mcpx/tool-install.ts`, false],
  [`${S}/core-extensions/ensure-core-extensions.ts`, `${S}/core-extension/x.ts`, false],
  [`${S}/mcp-apps/mcp-app-resource-service.ts`, `${S}/mcp-app/mcp-app-resource-service.ts`, false],
  // The capability doors on the front-door side (DOR-4978): chat from the web, runtime setup reads.
  [
    `${S}/core/session-relay-doors/session-relay-capabilities.ts`,
    `${S}/core/session-relay-door/x.ts`,
    false,
  ],
  [`${S}/core/runtime-doors/runtime-read-capabilities.ts`, `${S}/core/runtime-door/x.ts`, false],
  // The chat reads on the capability mount (DOR-4978): who may read a chat.
  [`${S}/session/reads/session-read-capabilities.ts`, `${S}/session/readers/x.ts`, false],
  // C2's new kernel homes (DOR-5303): code moved out of covered folders stays covered.
  [`${S}/core/child-bundle/child-bundle.ts`, `${S}/core/child-bundles/child-bundle.ts`, false],
  [`${S}/core/room-turn-ref/room-turn-ref.ts`, `${S}/core/room-turn-refs/room-turn-ref.ts`, false],
  [`${S}/core/skills-ledger/skill-plugin-roots.ts`, `${S}/core/skills-ledgers/x.ts`, false],
  [`${S}/core/room-conventions/room-conventions-block.ts`, `${S}/core/room-convention/x.ts`, true],
  [
    `${S}/core/room-worktree-name/room-worktree-name.ts`,
    `${S}/core/room-worktree-names/x.ts`,
    true,
  ],
  // C3's kernel home (DOR-5403): the Connections lease types left services/connectors/.
  [
    `${S}/core/connections-lease/runtime-principal-port.ts`,
    `${S}/core/connections-leases/x.ts`,
    false,
  ],
  // C9a's kernel homes (DOR-5482): the agent tool kit and the tool names left runtimes/.
  [`${S}/core/agent-tool-kit/agent-tool-kit.ts`, `${S}/core/agent-tool-kits/x.ts`, false],
  [`${S}/core/tool-names/tool-names.ts`, `${S}/core/tool-name/x.ts`, false],
]) {
  test(`${match.slice(S.length + 1)} is on the main list${deep ? ' and the deep list' : ' only'}`, () => {
    assert.ok(existsSync(resolve(root, match)), `${match} no longer exists`);
    const deepPattern = securityDeepPathPattern();
    assert.ok(touchesSecurity([{ filename: match }], reference), 'main');
    assert.ok(
      touchesSecurity([{ filename: 'docs/moved.md', previous_filename: match }], reference)
    );
    assert.equal(touchesSecurity([{ filename: match }], deepPattern), deep, 'deep');
    assert.equal(touchesSecurity([{ filename: miss }], reference), false, miss);
    assert.equal(touchesSecurity([{ filename: miss }], deepPattern), false, miss);
  });
}

// C2's and C3's shared homes (DOR-5303, DOR-5403): main list only.
for (const [match, miss] of [
  ['packages/shared/src/chat-client-id.ts', 'packages/shared/src/chat-client-ids.ts'],
  ['packages/shared/src/heartbeat-schemas.ts', 'packages/shared/src/heartbeat-schema.ts'],
  ['packages/shared/src/room-attachment-paths.ts', 'packages/shared/src/room-attachment-path.ts'],
  // C3 (DOR-5403): the Connections lease's plain values left services/connectors/.
  ['packages/shared/src/connections-lease.ts', 'packages/shared/src/connections-leases.ts'],
  // The caller-bar labels (DOR-4978): who a person-bar caller is shown as, and the bars' declarations.
  ['packages/shared/src/activity-schemas.ts', 'packages/shared/src/activity-schema.ts'],
  ['packages/shared/src/capabilities.ts', 'packages/shared/src/capabilities-extra.ts'],
  // C4 (DOR-5444): the test-mode scenario world and its stand-in cloud link left runtimes/test-mode/.
  [
    'apps/server/src/startup/test-composition/fake-cloud-link.ts',
    'apps/server/src/startup/test-compositions/fake-cloud-link.ts',
  ],
  // DOR-4931: the secret files (host key, extension secrets) left @dorkos/shared for the server's lib/.
  [
    'apps/server/src/lib/secret-store/secret-file.ts',
    'apps/server/src/lib/secret-stores/secret-file.ts',
  ],
  [
    'apps/server/src/lib/secret-store/extension-secrets.ts',
    'apps/server/src/lib/secret-store-notes/extension-secrets.ts',
  ],
  // C5 (DOR-5457): visibility homes. Whose browser an agent may use, and who sees which chats.
  [
    'apps/server/src/services/core/browser-registry/owner/owner-scope-resolver.ts',
    'apps/server/src/services/core/browser-registry-x/owner-scope-resolver.ts',
  ],
  [
    'apps/server/src/services/session/catalog/session-list-space-view.ts',
    'apps/server/src/services/session/catalog/session-list-space-views.ts',
  ],
  [
    'apps/server/src/services/session/chat-rows/chat-rows-port.ts',
    'apps/server/src/services/session/chat-rowsx/chat-rows-port.ts',
  ],
  // C14 (DOR-5459): the asks port. What a consent card asks and how a yes is
  // keyed and bound, and the slots the computer side asks through.
  ['packages/shared/src/computer-asks.ts', 'packages/shared/src/computer-asks-old.ts'],
  ['packages/shared/src/approval-text.ts', 'packages/shared/src/approval-texts.ts'],
  ['packages/shared/src/consent-entries.ts', 'packages/shared/src/consent-entries-old.ts'],
  ['packages/shared/src/folder-allows-card.ts', 'packages/shared/src/folder-allows-cards.ts'],
  ['apps/server/src/startup/computer-asks.ts', 'apps/server/src/startup/computer-asks-old.ts'],
  [
    'apps/server/src/services/runtimes/computer-asks.ts',
    'apps/server/src/services/runtimesx/computer-asks.ts',
  ],
  [
    'apps/server/src/services/harness/computer-asks.ts',
    'apps/server/src/services/harnessx/computer-asks.ts',
  ],
  [
    'apps/server/src/services/core/approvals/computer-asks/consent-config.ts',
    'apps/server/src/services/core/approvalsx/computer-asks/consent-config.ts',
  ],
  // DOR-5258 (Security t1j): the OpenCode project-plugin guard and re-check, the asks check
  // and prompt that arm it, and the sidecar's manager and custody that a restart kills.
  [
    'apps/server/src/services/runtimes/opencode/messaging/project-plugin-guard.ts',
    'apps/server/src/services/runtimes/opencode/messaging/project-plugin-guards.ts',
  ],
  [
    'apps/server/src/services/runtimes/opencode/messaging/project-plugin-recheck.ts',
    'apps/server/src/services/runtimes/opencode/messaging/project-plugin-recheck.test.ts',
  ],
  [
    'apps/server/src/services/runtimes/opencode/messaging/keep-asks.ts',
    'apps/server/src/services/runtimes/opencode/keep-asks.ts',
  ],
  [
    'apps/server/src/services/runtimes/opencode/server-manager.ts',
    'apps/server/src/services/runtimes/opencode/sessions/server-manager.ts',
  ],
  [
    'apps/server/src/services/runtimes/opencode/sidecar-custody.ts',
    'apps/server/src/services/runtimes/opencode/sidecar-custody-old.ts',
  ],
  [
    'apps/server/src/services/runtimes/opencode/tool-turn/prompt.ts',
    'apps/server/src/services/runtimes/opencode/tool-turn/prompts.ts',
  ],
  // C14 (DOR-5459): the CLI verbs that write or show consent, and the store they write through.
  ['packages/cli/src/consent-config-store.ts', 'packages/cli/src/consent-config-stores.ts'],
  ['packages/cli/src/harness-consent.ts', 'packages/cli/src/harness-consent.test.ts'],
  ['packages/cli/src/harness-sync-command.ts', 'packages/cli/src/harnessx-sync-command.ts'],
  ['packages/cli/src/harness-global-command.ts', 'packages/cli/src/lib/harness-global-command.ts'],
  ['packages/cli/src/harness-adopt-command.ts', 'packages/cli/src/harness_adopt-command.ts'],
  ['packages/cli/src/harness-hooks-command.ts', 'packages/cli/src/harness-hooks-command.tsx'],
  // C18 (DOR-5462): the agent facts port. Whose home a folder is, where an agent may
  // work and git may run, and the token a launch hands the agent, through the slots
  // the computer side reads and the startup step that fills them.
  ['packages/shared/src/agent-facts.ts', 'packages/shared/src/agent-facts-old.ts'],
  ['apps/server/src/startup/agent-facts.ts', 'apps/server/src/startup/agent-facts-old.ts'],
  [
    'apps/server/src/services/runtimes/agent-facts.ts',
    'apps/server/src/services/runtimesx/agent-facts.ts',
  ],
  [
    'apps/server/src/services/session/turn-port/agent-facts.ts',
    'apps/server/src/services/session/turn-portx/agent-facts.ts',
  ],
  ['apps/server/src/services/diff/agent-facts.ts', 'apps/server/src/services/diffx/agent-facts.ts'],
  [
    'apps/server/src/services/harness/agent-facts.ts',
    'apps/server/src/services/harness/agent-facts-old.ts',
  ],
  // C18 (DOR-5462): moved out of services/marketplace/, which the list holds.
  [
    'apps/server/src/services/harness/marketplace-repo-key.ts',
    'apps/server/src/services/harness/marketplace-repo-keys.ts',
  ],
  // C18 (DOR-5462), at Security's ask: the step that hands the turn-context record the
  // local /mcp token to sweep for, and the record's install that takes it.
  [
    'apps/server/src/startup/steps/core-stores.ts',
    'apps/server/src/startup/steps/core-stores-old.ts',
  ],
  [
    'apps/server/src/services/session/turn-context/index.ts',
    'apps/server/src/services/session/turn-context/record-turn-context.ts',
  ],
  // C18 (DOR-5462): git status holds git's kill switch for the files directly in core/.
  [
    'apps/server/src/services/core/git-status.ts',
    'apps/server/src/services/core/git-status-old.ts',
  ],
  // The bars in lib/ every door asks (DOR-4978, Security t1j): who the caller is, and who may
  // make an account decision. Each file by name; a look-alike stays off.
  ['apps/server/src/lib/caller-authority.ts', 'apps/server/src/lib/caller-authority-extra.ts'],
  ['apps/server/src/lib/caller-principal.ts', 'apps/server/src/lib/caller-principals.ts'],
  ['apps/server/src/lib/file-route-guards.ts', 'apps/server/src/lib/file-route-guard.ts'],
  [
    'apps/server/src/lib/person-without-session.ts',
    'apps/server/src/lib/person-without-sessions.ts',
  ],
  [
    'apps/server/src/lib/http/account-decision-bar.ts',
    'apps/server/src/lib/http/account-decision-bars.ts',
  ],
  ['apps/server/src/lib/http/own-origin-write.ts', 'apps/server/src/lib/http/own-origin-writes.ts'],
  ['apps/server/src/lib/http/person-bar.ts', 'apps/server/src/lib/http/person-bars.ts'],
]) {
  test(`${match} is on the main list only`, () => {
    assert.ok(existsSync(resolve(root, match)), `${match} no longer exists`);
    assert.ok(touchesSecurity([{ filename: match }], reference), 'main');
    assert.equal(touchesSecurity([{ filename: match }], securityDeepPathPattern()), false, 'deep');
    assert.equal(touchesSecurity([{ filename: miss }], reference), false, miss);
  });
}

test('both trusted gate workflows pin all actions to full commit SHAs', () => {
  // The initializer has two jobs since the base-copy verdict (pull_request_target and merge_group).
  for (const [name, count] of [
    ['security-gate.yml', 2],
    ['security-review-initialize.yml', 4],
  ]) {
    const workflow = readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
    const uses = [...workflow.matchAll(/^\s*- uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
    assert.equal(uses.length, count, name);
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
