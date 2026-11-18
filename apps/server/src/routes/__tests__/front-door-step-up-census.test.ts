/** Every front-door write has a confirmation row or an explicit, reasoned exception. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { exportedHandler, unguardedWrites } from './front-door-write-flow.js';
import { HELD_WRITES } from '../../services/core/auth/step-up/front-door-openapi.js';

const ROUTES = path.resolve(__dirname, '..');
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
};
const OTHER_FRONT_DOOR_CALLERS: Record<string, string> = {
  'admin.ts': 'Reset prepare creates only a one-use reset token; no lasting credential (N).',
  'extension-caller-token.ts':
    'Short-lived, session-bound frame identity only; no lasting credential (N).',
  'workbench-serve.ts':
    'Scoped serve/proxy URLs are transient preview grants, not front-door credentials (N).',
  'mcp-servers.ts': 'Already holds add, replace and widen; mcp-servers-step-up.test.ts covers it.',
  'runtimes-http.ts': 'Runtime sign-in and model settings are N.',
  'runtimes-doe-setup.ts': 'Runtime sign-in and model settings are N.',
  'cloud-owner-bar.ts': 'Shared account owner bar; writes are classified in its callers.',
  'cloud-community-move-http.ts': 'Delegated cloud-communities POST /moves hold, checked below.',
  'account-signin.ts': 'Runtime account sign-in is N.',
  'computers.ts': 'Computer naming and removal; own separate owner checks.',
  'connector-providers.ts': 'Connected-app operations retain their own approval flow.',
  'connector-spending.ts':
    'Holds raising the spend limit or lowering a price (DOR-4204); lowering or clearing is free. connector-spending.test.ts.',
  'heartbeats.ts': 'Beat preferences and schedule ownership; no front-door credentials.',
  'local-browser.ts': 'Browser actions retain their existing person checks.',
  'local-browser-profiles.ts': 'Browser profiles retain their existing person checks.',
  'local-browser-profile-removal.ts': 'Only removes access.',
  'your-browser.ts': 'Browser handoff retains its existing person checks.',
  'relay-adapter-http.ts': 'Chat connections retain their separate consent flow.',
  'onboarding.ts':
    'Credits choices only while first run is open; closing first run removes this setup door.',
  'tasks.ts':
    'Credits create and edit delegate to held handlers; trigger runs once without changing a lasting credits choice.',
  'tasks-create-http.ts':
    'Holds credits create before dispatch; task-credits-step-up.test.ts covers each route.',
  'tasks-update-http.ts':
    'Holds credits grants and live work edits, binds the task revision and revalidates before dispatch.',
  'sessions.ts':
    'Session Runs on ends with that session; session-tools/task-tools credits tests prove children do not inherit it (N).',
  'session-continue.ts':
    'Per-session Runs on is N; limit-plans-eligibility proves automatic carry-over uses its independently allowed target.',
  'relay-adapter-setting-routes.ts': 'Connection settings retain their separate approval flow.',
  'mesh-agent-patch-http.ts':
    'Delegated mesh PATCH holds credits-on and rechecks the agent and manifest; mesh-credits-step-up.test.ts covers it.',
  'front-door-step-up.ts': 'The shared helper itself rechecks the bar.',
};

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
};
const DELEGATES = new Map([
  ['patchConfig', exportedHandler(parse('config-patch-http'), 'patchConfig')],
  [
    'startHostedSpaceMove',
    exportedHandler(parse('cloud-community-move-http'), 'startHostedSpaceMove'),
  ],
]);

const rows = GROUPS.flatMap((name) => {
  const source = parse(name);
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
  const found: { id: string; calls: Set<string>; policy: string; handlers: readonly ts.Node[] }[] =
    [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const [route, ...handlers] = node.arguments;
      if (['post', 'put', 'patch', 'delete'].includes(method) && route) {
        if (!ts.isStringLiteral(route))
          throw new Error(`${name}: a write route needs a literal census path`);
        const id = `${name} ${method.toUpperCase()} ${route.text}`;
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
    };
    for (const { id, policy } of rows) {
      if (policy === 'exception') continue;
      const [group, method, route] = id.split(' ') as [string, string, string];
      const path = ((prefixes[group] ?? `/api/${group}`) + (route === '/' ? '' : route)).replace(
        /:([A-Za-z0-9_]+)/g,
        '{$1}'
      );
      expect(HELD_WRITES.has(`${method.toLowerCase()} ${path}`), id).toBe(true);
    }
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
        return [...callsFrom(source, new Map())].some((name) => bars.has(name));
      });
    for (const file of callers) {
      expect(
        GROUPS.includes(file.replace(/\.ts$/, '')) || file in OTHER_FRONT_DOOR_CALLERS,
        `${file} must join the front-door step-up census`
      ).toBe(true);
    }
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
