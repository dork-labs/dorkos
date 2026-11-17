/** Every front-door write has a confirmation row or an explicit, reasoned exception. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { exportedHandler, unguardedWrites } from './front-door-write-flow.js';
import { HELD_WRITES } from '../../services/core/auth/step-up/front-door-openapi.js';

const ROUTES = path.resolve(__dirname, '..');
/** The groups DOR-4355 M3 held, each write route judged on its own. */
const M3_GROUPS = [
  'connector-management',
  'connector-resources',
  'connector-events',
  'connector-providers',
  'connector-access-changes',
  'mini-app-access-page',
  'marketplace/package-actions',
  'marketplace/updates',
  'marketplace/dev-links',
  'marketplace/held-back',
  'marketplace/sources',
  'shapes',
  'workspaces',
  'task-file-approve',
  'task-mode-undo',
  'runtimes',
  'runtimes-account-eligibility',
  'community-connections',
  'community-answer-in',
  'community-teammate-spend',
  'canvas-doc-route-controls',
  'extensions',
  'permissions',
  'relay-adapters',
  'relay-binding-step-up',
  'relay-adapter-setting-routes',
  'unclaimed-chats',
];
const GROUPS = [
  'remote-access',
  'tunnel',
  'lan-access',
  'extensions-trusted-sources',
  'cloud',
  'cloud-communities',
  'devices',
  'session-relay',
  'session-relay-passkeys',
  'config',
  'heartbeat-triage',
  'tasks',
  'mesh',
  // DOR-4355 M3, checked per route (Security S4): reverting any one hold turns its row red.
  ...M3_GROUPS,
];
const EXCEPTIONS: Record<string, string> = {
  'mesh POST /discover': 'Reads agent candidates; grants no account access.',
  'mesh POST /agents': 'Registers an agent without recording credits consent.',
  'mesh PUT /topology/access':
    'Changes agent-to-agent visibility without granting credentials or spending consent.',
  'mesh POST /agents/:id/heartbeat': 'Records agent health.',
  'mesh DELETE /agents/:id/data': 'Removes an agent and its data.',
  'mesh DELETE /agents/:id': 'Removes an agent.',
  'mesh POST /deny': 'Prevents agent discovery.',
  'mesh DELETE /denied':
    'Removes a discovery denial without granting credentials or spending consent.',
  'tasks DELETE /:id': 'Removes a scheduled task.',
  'tasks POST /:id/trigger':
    'Runs once under its existing owner bar without changing any lasting credits choice.',
  'tasks POST /runs/:id/cancel': 'Stops a run.',
  'remote-access POST /close': 'Only closes access.',
  'remote-access POST /withdraw': 'Withdraws access.',
  'tunnel POST /stop': 'Only closes access.',
  'extensions-trusted-sources DELETE /trusted-sources': 'Removes trust.',
  'cloud POST /link/cancel': 'Cancels a link.',
  'cloud POST /unlink': 'Removes the account link.',
  'cloud POST /link/check': 'Checks an existing link; can only remove it.',
  'cloud POST /seats/:seatId/release': 'Releases a seat.',
  'cloud POST /credits/undo-filled': 'Removes credits choices.',
  'cloud POST /credits/notices/dismiss': 'Dismisses a notice.',
  'cloud-communities POST /moves/:moveId/cancel': 'Cancels a move.',
  'session-relay POST /pause': 'Only closes access.',
  'session-relay POST /presence/end': 'Only closes access.',
  'session-relay DELETE /link': 'Removes a link.',
  'session-relay-passkeys POST /finish':
    'Consumes the one-use enrol statement from confirmed /start.',
  'session-relay-passkeys DELETE /': 'Existing password check removes a damaged passkey file.',
  'session-relay-passkeys DELETE /:credentialId': 'Existing password check removes a passkey.',
  'config PUT /agents/defaultAgent': 'Changes a preference.',
  // DOR-4355 M3, route by route: each of these only narrows, reads or answers once.
  'connector-management POST /reviews': 'Asks the owner to review an agent; grants nothing.',
  'connector-management POST /reconciliation/previews':
    'Builds a review of current access to read; writes no grant.',
  'connector-management DELETE /connections/:connectionId/every-agent':
    'Stops sharing an account with every agent.',
  'connector-management PUT /connections/:connectionId/exclusions/:agentId':
    'Leaves one agent out of an account.',
  'connector-resources PATCH /connections/:connectionId': 'Renames an account.',
  'connector-resources POST /connections/:connectionId/remove': 'Removes an account.',
  'connector-resources DELETE /connections/:connectionId': 'Disconnects an account.',
  'connector-resources PUT /sessions/:sessionId/connections/:connectionId':
    'Turns an app the chat’s agent already holds on or off for one chat; never more than the agent’s own access.',
  'connector-events DELETE ${prefix}/subscriptions/:subscriptionId':
    'Removes an event subscription.',
  'connector-providers DELETE /:provider/credential': 'Removes a saved provider key.',
  'marketplace/package-actions POST /packages/:name/preview':
    'Shows what an install would do; installs nothing.',
  'marketplace/package-actions POST /packages/:name/check-files':
    'Checks installed files against the record; changes nothing.',
  'marketplace/package-actions POST /packages/:name/uninstall': 'Removes a package.',
  'marketplace/package-actions POST /packages/:name/update':
    'Checks for a newer version; applying one is held in updates.ts.',
  'marketplace/dev-links POST /dev-links/preview': 'Shows what a link would run; links nothing.',
  'marketplace/dev-links POST /dev-links/:name/unlink': 'Removes a linked folder.',
  'marketplace/held-back POST /held-back/:name/review':
    'Asks the person about a held-back package on a card; allows nothing.',
  'marketplace/sources DELETE /sources': 'Removes package sources.',
  'marketplace/sources DELETE /sources/:name': 'Removes a package source.',
  'marketplace/sources POST /sources/refresh':
    'Re-reads the sources a person already added; adds none.',
  'marketplace/sources POST /sources/:name/refresh':
    'Re-reads a source a person already added; adds none.',
  'shapes POST /:name/fork': 'Copies a Shape to edit; applies nothing.',
  'workspaces POST /ports': 'Reads a workspace’s ports.',
  'workspaces POST /:id/pin': 'Pins a workspace in the list.',
  'runtimes POST /opencode/provision':
    'Installs OpenCode at this computer only; grants no account or key.',
  'runtimes POST /codex/provision':
    'Installs Codex at this computer only; grants no account or key.',
  'runtimes POST /claude-code/provision':
    'Installs Claude Code at this computer only; grants no account or key.',
  'runtimes POST /opencode/ollama/pull': 'Downloads a local model at this computer only.',
  'runtimes POST /opencode/ollama/provision': 'Points OpenCode at a local model on this computer.',
  'runtimes POST /opencode/provider/credential/check': 'Tries a key; saves nothing.',
  'runtimes POST /claude-code/accounts/:id/probe': 'Checks an account signs in; saves nothing.',
  'runtimes POST /claude-code/accounts/found/dismiss': 'Hides a found account from the list.',
  'runtimes POST /:type/credential/check': 'Tries a key; saves nothing.',
  'runtimes POST /:type/login':
    'Starts a runtime’s own sign-in, which the person finishes in its window.',
  'runtimes-account-eligibility POST /claude-code/project-accounts/without-credits':
    'Keeps DorkOS credits out of one project; only narrows.',
  'community-connections POST /navigation/move': 'Moves a space in the sidebar.',
  'community-connections PUT /navigation/installation': 'Chooses where a space shows.',
  'community-connections PUT /navigation/destination': 'Chooses where a space opens.',
  'community-connections POST /:ref/poll': 'Reads whether a pairing finished.',
  'community-connections POST /:ref/cancel': 'Cancels a pairing.',
  'community-connections DELETE /:ref': 'Removes a space connection.',
  'canvas-doc-route-controls POST /:id/routes/:routeId/review':
    'Marks a page route reviewed; grants nothing.',
  'canvas-doc-route-controls POST /:id/routes/:routeId/revoke': 'Stops a page route.',
  'extensions POST /:id/disable': 'Turns an extension off.',
  'extensions POST /:id/init-server':
    'Starts the server of an extension that is already on; turns nothing on.',
  'extensions POST /reload': 'Reloads the extensions that are already on.',
  'extensions POST /cwd-changed': 'Loads the extensions of the folder the person opened.',
  'extensions PUT /:id/data': 'An extension’s own data file; grants nothing.',
  'extensions DELETE /:id/secrets/:key': 'Removes an extension’s secret.',
  'extensions PUT /:id/settings/:key':
    'An extension’s own non-secret settings; its secrets are held separately.',
  'extensions DELETE /:id/settings/:key': 'Removes an extension’s setting.',
  'relay-adapters POST /adapters/reload':
    'Re-reads the chat connections a person already saved; adds none.',
  'relay-adapters DELETE /adapters/:id': 'Removes a chat connection.',
  'relay-adapters POST /adapters/:id/disable': 'Turns a chat connection off.',
  'relay-adapters DELETE /bindings/:id': 'Removes a chat route.',
  'relay-adapters POST /bindings/:id/test': 'Sends a test message on a saved chat route.',
  'unclaimed-chats POST /:id/ignore': 'Ignores a chat nobody answers yet.',
  'unclaimed-chats POST /:id/block': 'Blocks a chat.',
  'unclaimed-chats POST /:id/leave': 'Leaves a chat.',
};
const OTHER_FRONT_DOOR_CALLERS: Record<string, string> = {
  'admin.ts': 'Reset prepare creates only a one-use reset token; no lasting credential (N).',
  'extension-caller-token.ts':
    'Short-lived, session-bound frame identity only; no lasting credential (N).',
  'workbench-serve.ts':
    'Scoped serve/proxy URLs are transient preview grants, not front-door credentials (N).',
  'mcp-servers.ts': 'Already holds add, replace and widen; mcp-servers-step-up.test.ts covers it.',
  'runtimes-http.ts':
    'Shared runtime bars and the key-save hold (HOLD_HELPERS); runtimes.ts routes are checked.',
  'runtimes-doe-setup.ts': 'Runtime sign-in and model settings are N.',
  'cloud-owner-bar.ts': 'Shared account owner bar; writes are classified in its callers.',
  'cloud-community-move-http.ts': 'Delegated cloud-communities POST /moves hold, checked below.',
  'account-signin.ts': 'Runtime account sign-in is N.',
  'computers.ts': 'Computer naming and removal; own separate owner checks.',
  'heartbeats.ts': 'Beat preferences and schedule ownership; no front-door credentials.',
  'local-browser.ts': 'Browser actions retain their existing person checks.',
  'local-browser-profiles.ts': 'Browser profiles retain their existing person checks.',
  'local-browser-profile-removal.ts': 'Only removes access.',
  'your-browser.ts': 'Browser handoff retains its existing person checks.',
  'relay-adapter-http.ts': 'Chat connections retain their separate consent flow.',
  'onboarding.ts':
    'Credits choices only while first run is open; closing first run removes this setup door.',
  'tasks-create-http.ts':
    'Holds credits create before dispatch; task-credits-step-up.test.ts covers each route.',
  'tasks-update-http.ts':
    'Holds credits grants, live work edits and raising what a task may do (a looser mode, approved tools, arming above Default); binds the task revision and revalidates before dispatch.',
  'sessions.ts':
    'Session Runs on ends with that session; session-tools/task-tools credits tests prove children do not inherit it (N).',
  'session-continue.ts':
    'Per-session Runs on is N; limit-plans-eligibility proves automatic carry-over uses its independently allowed target.',
  'mesh-agent-patch-http.ts':
    'Delegated mesh PATCH holds credits-on and rechecks the agent and manifest; mesh-credits-step-up.test.ts covers it.',
  'front-door-step-up.ts': 'The shared helper itself rechecks the bar.',
  // Shared bars and helpers: their callers are classified here one by one.
  'agent-instructions.ts': 'Reads an agent’s instructions; no write route.',
  'extension-write-binding.ts': 'Shared extension write bar; its callers are classified here.',
  'extensions-person-bar.ts': 'Shared extension person bar; its callers are classified here.',
  'remote-community-http.ts': 'Shared space request helper; no write route.',
  'community-space-settings.ts': 'Reads a space’s settings; no write route.',
  'community-administer.ts': 'Space administration answers; no lasting grant here.',
  'debug.ts': 'Reads which owner-only views to show; no write route.',
  'team.ts': 'Reads the team; no write route.',
  'session-workspace-caller.ts': 'Shared workspace check for a chat turn; no write route.',
  'marketplace/context.ts': 'Shared marketplace bars; its routes are classified here.',
  'harness.ts': 'Copies already-installed files into a project and moves a skill file (N).',
  // Writes that only narrow, answer once, or touch the person's own records (N).
  'canvas-doc-work-review.ts': 'Replays or clears one batch of a page’s events (N).',
  'connector-execution.ts': 'Runs a call under grants already given; grants nothing (N).',
  'connector-mini-app-access.ts': 'Only revokes a mini app’s account access (N).',
  'extensions-removal.ts': 'Only removes or forgets an extension (N).',
  'extensions-start-work.ts': 'Starts one chat, capped from Wi-Fi; grants nothing lasting (N).',
  'extensions-step-up.ts': 'Moves an extension out; the moved copy is never re-trusted (N).',
  'hook-review-routes.ts': 'Asks about a hook again; grants nothing (N).',
  'read-cursors.ts': 'Moves a read marker (N).',
  'remote-communities.ts':
    'The person’s own messages and memberships in a space; halts only lower (N).',
  'remote-community-conduct.ts': 'The person’s own rules answer, name and reports in a space (N).',
  'session-queue-handler.ts': 'Edits, removes or steers one queued message (N).',
  // Held in DOR-3648 (remote approval step-up), which merges first or in the same release.
  'approvals.ts': 'Card answers are held in DOR-3648.',
  'session-answers.ts': 'Always allow on a chat’s tool request is held in DOR-3648.',
  'extensions-approval.ts': 'Approving an extension to run is held in DOR-3648.',
  'extensions-approval-set.ts': 'Approving several extensions to run is held in DOR-3648.',
  'extension-decisions.ts': 'An extension’s standing offer accept is held in DOR-3648.',
  'extensions-forward.ts': 'Widening who an extension forwards to is held in DOR-3648.',
  'extensions-rooms.ts': 'Widening an extension’s rooms is held in DOR-3648.',
  'extensions-inbox.ts': 'Project settings writes from another device are held in DOR-3648.',
  // DOR-4355 M3's route files are in M3_GROUPS, judged per route. These are their helpers.
  'connector-step-up.ts': 'Shared connector hold helpers; their routes are in M3_GROUPS.',
  'task-arm-raise.ts': 'The task raise rules and holds (HOLD_HELPERS); their routes are checked.',
  'account-eligibility-hold.ts':
    'The account widening hold (HOLD_HELPERS); its routes are checked.',
  'relay-adapter-grants.ts': 'The approver/DM list rules, used by relay-adapter-setting-routes.ts.',
  // Not held: decided writes that are not a lasting grant, each a call for Security to confirm.
  'agents.ts':
    'Creates an agent only from the template or package review the person was shown (DOR-2325), and PATCH /current refuses operator-only fields (instructions and model, no grant).',
  'system-shell-check.ts': 'Continues past a shell check in memory until the next restart (N).',
};

/** What the route groups name their Hono app. */
const ROUTERS = new Set(['router', 'app']);

/**
 * Shared holds a route may call instead of `runFrontDoorWrite` itself, by the
 * file that exports each. A test below proves each one holds.
 */
const HOLD_HELPERS = new Map([
  ['holdBindingRaise', 'relay-binding-step-up'],
  ['holdAccountWidening', 'account-eligibility-hold'],
  ['holdCredentialSave', 'runtimes-http'],
  ['holdTaskArm', 'task-arm-raise'],
  ['holdTaskRaise', 'task-arm-raise'],
]);

/** Writes that grant lasting access without calling any person bar, so named here. */
const ALWAYS_DECIDED = new Set(['relay-adapters.ts']);

function parse(name: string) {
  const text = fs.readFileSync(path.join(ROUTES, `${name}.ts`), 'utf8');
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

/** Calls reachable through helpers in this route file, excluding comments and strings. */
function callsFrom(
  node: ts.Node,
  functions: Map<string, ts.Node>,
  seen = new Set<string>()
): Set<string> {
  const calls = new Set<string>();
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child)) {
      const name = ts.isIdentifier(child.expression)
        ? child.expression.text
        : ts.isPropertyAccessExpression(child.expression)
          ? child.expression.name.text
          : '';
      if (!name) {
        ts.forEachChild(child, visit);
        return;
      }
      calls.add(name);
      const helper = ts.isIdentifier(child.expression) ? functions.get(name) : undefined;
      if (helper && !seen.has(name)) {
        seen.add(name);
        for (const call of callsFrom(helper, functions, seen)) calls.add(call);
      }
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return calls;
}

// These conditions are the explicit N branches of mixed P/N routes.
const NARROWING: Record<string, string[]> = {
  'remote-access POST /mode': ["mode === 'off'"],
  'lan-access POST /': ['!parsed.data.enabled', '!enabled'],
  'config PATCH /': ['guarded.length === 0'],
  'session-relay PATCH /level': ["level !== 'full' || deps.readPin()?.level === 'full'"],
  'session-relay POST /resume': ['paused'],
  'devices DELETE /sessions/:id': ['own'],
  'cloud PUT /credits/default': ['!useCredits'],
  'heartbeat-triage PUT /': ['!useCredits'],
  // Not narrowing: an agent's link, which the tool gate already carded and decided.
  'marketplace/dev-links POST /dev-links': ['!person'],
};
const DELEGATES = new Map([
  ['patchConfig', exportedHandler(parse('config-patch-http'), 'patchConfig')],
  [
    'startHostedSpaceMove',
    exportedHandler(parse('cloud-community-move-http'), 'startHostedSpaceMove'),
  ],
]);

/** Every named function in a file, so a call can be followed into its helper. */
function functionsOf(source: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  function collect(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body)
      functions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      functions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(source);
  return functions;
}

const rows = GROUPS.flatMap((name) => {
  const source = parse(name);
  const functions = functionsOf(source);
  const found: { id: string; calls: Set<string>; policy: string; handlers: readonly ts.Node[] }[] =
    [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      // A route is registered on the group's Hono app; `someSet.delete(x)` is not a route.
      ts.isIdentifier(node.expression.expression) &&
      ROUTERS.has(node.expression.expression.text)
    ) {
      const method = node.expression.name.text;
      const [route, ...handlers] = node.arguments;
      if (['post', 'put', 'patch', 'delete'].includes(method) && route) {
        // A template path is named as written, `${action}` and all, so each one still needs a row.
        if (!ts.isStringLiteral(route) && !ts.isTemplateLiteral(route))
          throw new Error(`${name}: a write route needs a literal census path`);
        const literal = ts.isStringLiteral(route) ? route.text : route.getText().slice(1, -1);
        const id = `${name} ${method.toUpperCase()} ${literal}`;
        if (
          handlers.length === 1 &&
          ts.isIdentifier(handlers[0]!) &&
          handlers[0]!.text === 'hubLinkWriteBar'
        )
          return;
        const calls = new Set(handlers.flatMap((handler) => [...callsFrom(handler, functions)]));
        found.push({ id, calls, policy: EXCEPTIONS[id] ? 'exception' : 'step-up', handlers });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
});

describe('front-door write census', () => {
  it.each(rows)('$id: $policy', ({ id, calls, policy, handlers }) => {
    if (policy === 'exception') {
      expect(EXCEPTIONS[id]).toMatch(/\S.+\.$/);
      return;
    }
    const guarded =
      calls.has('runFrontDoorWrite') ||
      calls.has('runAccountWrite') ||
      calls.has('holdForStepUp') ||
      [...HOLD_HELPERS.keys()].some((helper) => calls.has(helper)) ||
      (id === 'config PATCH /' && calls.has('patchConfig')) ||
      (id === 'cloud-communities POST /moves' && calls.has('startHostedSpaceMove')) ||
      (id === 'tasks POST /' && calls.has('createTaskHttp')) ||
      (id === 'tasks PATCH /:id' && calls.has('updateTaskHttp')) ||
      (id === 'mesh PATCH /agents/:id' && calls.has('patchMeshAgent'));
    expect(guarded, `${id} needs a step-up before writing`).toBe(true);
    expect(
      unguardedWrites(handlers, NARROWING[id] ?? [], DELEGATES),
      `${id} writes before its hold or in an unclassified branch`
    ).toEqual([]);
  });

  it.each([...HOLD_HELPERS])('the shared hold %s really holds', (helper, file) => {
    const source = parse(file);
    const fn = exportedHandler(source, helper);
    const calls = callsFrom(fn, functionsOf(source));
    expect(
      calls.has('runFrontDoorWrite') || calls.has('runAccountWrite'),
      `${file}: ${helper} must hold through the shared bar`
    ).toBe(true);
  });

  it.each([
    [
      "configManager.set('server', value); return runFrontDoorWrite(c, { run: async () => configManager.set('server', value) });",
      [],
    ],
    [
      'const run = async () => signOutSession(); if (somethingElse) return run(); return runFrontDoorWrite(c, { run });',
      ['own'],
    ],
  ])('rejects a write outside the held branch', (body, narrowing) => {
    const source = ts.createSourceFile(
      'mutation.ts',
      `const handler = async () => { ${body} };`,
      ts.ScriptTarget.Latest,
      true
    );
    const declaration = source.statements[0] as ts.VariableStatement;
    const handler = declaration.declarationList.declarations[0]!.initializer!;
    expect(unguardedWrites([handler], narrowing, new Map())).toHaveLength(1);
  });

  it('accepts an explicit narrowing branch while still checking its held sibling', () => {
    const source = ts.createSourceFile(
      'narrowing.ts',
      `const handler = async () => {
      const run = async () => signOutSession();
      if (own) return run();
      return runFrontDoorWrite(c, { run });
    };`,
      ts.ScriptTarget.Latest,
      true
    );
    const declaration = source.statements[0] as ts.VariableStatement;
    expect(
      unguardedWrites(
        [declaration.declarationList.declarations[0]!.initializer!],
        ['own'],
        new Map()
      )
    ).toEqual([]);
  });

  // These handlers re-enter their validator after confirmation, so their lasting
  // write follows a terminal hold branch rather than sitting inside its callback.
  it.each([
    [
      'tasks-create-http',
      'createTaskHttp',
      'namesCredits(body) && !confirming',
      'createScheduledTask',
    ],
    ['tasks-update-http', 'updateTaskHttp', 'grantsCredits && !confirming', 'applyTaskFileUpdate'],
    [
      'mesh-agent-patch-http',
      'patchMeshAgent',
      'grantsCredits && !confirmation',
      'setCreditsAllowedForAgent',
    ],
  ])('%s keeps its credits hold before the lasting write', (file, name, condition, write) => {
    const handler = exportedHandler(parse(file), name);
    expect(handler.body && ts.isBlock(handler.body)).toBe(true);
    const statements = (handler.body as ts.Block).statements;
    const compact = (text: string) => text.replace(/\s+/g, '');
    const guard = statements.find(
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && compact(node.expression.getText()) === compact(condition)
    );
    expect(guard, `${file}: the credits branch must hold before dispatch`).toBeDefined();
    const branch = guard!.thenStatement as ts.Block;
    const returned = branch.statements.at(-1);
    expect(
      returned &&
        ts.isReturnStatement(returned) &&
        returned.expression &&
        ts.isCallExpression(returned.expression) &&
        returned.expression.expression.getText()
    ).toBe('runAccountWrite');
    const writes: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText() === write) writes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(handler);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.pos).toBeGreaterThan(guard!.end);
  });

  it.each([
    'ns.refuseFrontDoorChange(facts)',
    'bar.errorRefusalUnlessOwner(facts, wording)',
    'bar.envelopeRefusalUnlessOwner(facts, wording)',
  ])('discovers namespaced bars: %s', (code) => {
    const source = ts.createSourceFile('namespace.ts', code, ts.ScriptTarget.Latest, true);
    expect([...callsFrom(source, new Map())]).toHaveLength(1);
    expect([...callsFrom(source, new Map())][0]).toMatch(
      /^(refuseFrontDoorChange|errorRefusalUnlessOwner|envelopeRefusalUnlessOwner)$/
    );
  });
  it('documents every guarded census row with a 428 response', () => {
    const prefixes: Record<string, string> = {
      'extensions-trusted-sources': '/api/extensions',
      'cloud-communities': '/api/cloud/communities',
      'session-relay-passkeys': '/api/session-relay/passkeys',
      'heartbeat-triage': '/api/heartbeats/triage-credits',
      // DOR-4355 M3: where each group is mounted.
      'connector-management': '/api/connectors',
      'connector-resources': '/api/connectors',
      'connector-events': '/api/connectors',
      'connector-access-changes': '/api/connectors',
      'mini-app-access-page': '/api/connectors',
      'connector-providers': '/api/connectors/providers',
      'marketplace/package-actions': '/api/marketplace',
      'marketplace/updates': '/api/marketplace',
      'marketplace/dev-links': '/api/marketplace',
      'marketplace/held-back': '/api/marketplace',
      'marketplace/sources': '/api/marketplace',
      'task-file-approve': '/api/tasks',
      'task-mode-undo': '/api/tasks',
      'runtimes-account-eligibility': '/api/runtimes',
      'community-connections': '/api/community-connections',
      'community-answer-in': '/api/community-connections',
      'community-teammate-spend': '/api/community-connections',
      'canvas-doc-route-controls': '/api/canvas/docs',
      permissions: '/api',
      'relay-adapters': '/api/relay',
      'relay-binding-step-up': '/api/relay',
      'relay-adapter-setting-routes': '/api/relay',
      'unclaimed-chats': '/api/relay/unclaimed-chats',
    };
    const missing: string[] = [];
    for (const { id, policy } of rows) {
      if (policy === 'exception') continue;
      const [group, method, route] = id.split(' ') as [string, string, string];
      // Template paths, as their files define them; of pause and resume, resume is the one held.
      const literal = route
        .replace('${prefix}', '/connections/:connectionId/events')
        .replace('${BASE}', '/mini-app-access')
        .replace('${action}', 'resume');
      const path = (
        (prefixes[group] ?? `/api/${group}`) + (literal === '/' ? '' : literal)
      ).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const key = `${method.toLowerCase()} ${path}`;
      if (!HELD_WRITES.has(key)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  // Security S4 on DOR-4355 M3: a file judged per route is never also excused as a whole.
  it('never excuses a route group as a whole file', () => {
    const both = GROUPS.filter((group) => `${group}.ts` in OTHER_FRONT_DOOR_CALLERS);
    expect(both).toEqual([]);
  });

  it('keeps every exception attached to a real route', () => {
    for (const id of Object.keys(EXCEPTIONS))
      expect(
        rows.some((row) => row.id === id),
        id
      ).toBe(true);
  });

  it('requires a census decision for a new front-door route group', () => {
    const bars = new Set([
      'refuseFrontDoorChange',
      'requirePersonAtThisComputer',
      'refuseUnlessAccountOwner',
      'errorRefusalUnlessOwner',
      'envelopeRefusalUnlessOwner',
      // Every other person bar: a write a person may make can be a lasting grant (DOR-4355 M3).
      'requirePerson',
      'refusedNotAPerson',
      'personOrRefuse',
      'clearsTheAgentBar',
      'resolveConnectorOperator',
      'resolveCommunityOwner',
      'requireOperatorCookieUnderLogin',
      'decisionAuthority',
      'resolveDecisionAuthority',
      'readCallerAuthority',
      'trustedCaller',
    ]);
    const callers = fs
      .readdirSync(ROUTES, { recursive: true })
      .filter(
        (file): file is string =>
          typeof file === 'string' && file.endsWith('.ts') && !file.includes('__tests__')
      )
      .filter((file) => {
        const source = ts.createSourceFile(
          file,
          fs.readFileSync(path.join(ROUTES, file), 'utf8'),
          ts.ScriptTarget.Latest,
          true
        );
        return (
          ALWAYS_DECIDED.has(file) ||
          [...callsFrom(source, new Map())].some((name) => bars.has(name))
        );
      });
    const undecided = callers.filter(
      (file) => !GROUPS.includes(file.replace(/\.ts$/, '')) && !(file in OTHER_FRONT_DOOR_CALLERS)
    );
    expect(undecided, 'each of these must join the front-door step-up census').toEqual([]);
  });

  it('keeps the general settings write and API key writes behind the same hold', () => {
    expect(callsFrom(parse('config-patch-http'), new Map())).toContain('runFrontDoorWrite');
    const auth = fs.readFileSync(path.join(ROUTES, '../http/better-auth.ts'), 'utf8');
    const authSource = ts.createSourceFile('auth', auth, ts.ScriptTarget.Latest, true);
    expect(callsFrom(authSource, new Map())).toContain('confirmAuthWrite');
    const routeLiterals = new Set<string>();
    const collectLiterals = (node: ts.Node) => {
      if (ts.isStringLiteral(node)) routeLiterals.add(node.text);
      ts.forEachChild(node, collectLiterals);
    };
    collectLiterals(authSource);
    const heldAuth = fs.readFileSync(path.join(ROUTES, '../http/better-auth-step-up.ts'), 'utf8');
    expect(
      callsFrom(ts.createSourceFile('auth', heldAuth, ts.ScriptTarget.Latest, true), new Map())
    ).toContain('runFrontDoorWrite');
    expect(callsFrom(parse('cloud-community-move-http'), new Map())).toContain('runAccountWrite');
    expect(routeLiterals).toContain('/api/auth/api-key/create');
    expect(routeLiterals).toContain('/api/auth/api-key/update');
    for (const route of ['revoke-session', 'revoke-other-sessions', 'revoke-sessions']) {
      expect(routeLiterals).toContain(`/api/auth/${route}`);
    }
  });
});
