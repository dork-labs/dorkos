/**
 * Every write the server serves, decided for an agent computer (DOR-2940).
 *
 * Each write route in the route census (`http/__tests__/route-census.baseline.json`,
 * which `route-census.test.ts` holds equal to the real app) is classified here
 * exactly once, with a reason: open to agents (`AGENT_COMPUTER_WRITES`),
 * decided by its own authorizer (`/mcp`, A2A), or refused (`REFUSED`). A new
 * write route fails this file until someone puts it on one side. Then the
 * real gate is asked about every route, so the table cannot be right while
 * the gate disagrees.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../agent-identity/agent-identity-service.js', () => ({
  getAgentIdentityService: () => ({
    resolve: async (token: string) =>
      token === 'agent-live' ? { agentPath: '/agents/a', displayName: 'A' } : undefined,
  }),
}));

const { AGENT_COMPUTER_WRITES, agentComputerRouteRefusal } = await import('../agent-writes.js');
const { decideAgentComputerGate } = await import('../agent-gate.js');

const BASELINE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../http/__tests__/route-census.baseline.json'
);

/** Every route the server serves that is not a plain read. */
const WRITE_ROUTES: readonly string[] = (
  JSON.parse(readFileSync(BASELINE, 'utf8')) as { routes: string[] }
).routes.filter((route) => !route.startsWith('GET '));

/** Writes their own authorizer decides (`middleware/mcp-auth.ts`), never this table. */
const OWN_AUTHORIZER: ReadonlyMap<string, string> = new Map([
  ['ALL /mcp', 'the MCP endpoint; its actions meet the capability gates'],
  ['POST /mcp', 'the MCP endpoint; its actions meet the capability gates'],
  ['DELETE /mcp', 'the MCP endpoint; its actions meet the capability gates'],
  ['POST /a2a', 'A2A, decided as /mcp is'],
  ['POST /a2a/agents/:id', 'A2A, decided as /mcp is'],
]);

/** Every write an agent computer refuses to agents, by why. */
const REFUSED: readonly (readonly [reason: string, routes: readonly string[]])[] = [
  [
    'setup is the hub’s',
    [
      'ALL /api/admin/*',
      'POST /api/admin/reset',
      'POST /api/admin/reset/prepare',
      'POST /api/admin/restart',
    ],
  ],
  ['no person signs in or up here', ['ALL /api/auth/*']],
  ['middleware in front of the routes it guards', ['ALL /api/canvas/docs/*']],
  [
    'the DorkOS account is the hub’s (also sealed)',
    [
      'ALL /api/cloud/communities/*',
      'POST /api/cloud/account/deletion',
      'POST /api/cloud/account/export',
      'POST /api/cloud/billing/:page',
      'POST /api/cloud/communities',
      'POST /api/cloud/communities/:communityId/claim-link',
      'POST /api/cloud/communities/:communityId/keep',
      'POST /api/cloud/communities/:communityId/restore',
      'POST /api/cloud/communities/moves',
      'POST /api/cloud/communities/moves/:moveId/cancel',
      'POST /api/cloud/communities/moves/:moveId/upload',
      'POST /api/cloud/credits/notices/dismiss',
      'POST /api/cloud/credits/undo-filled',
      'POST /api/cloud/link/cancel',
      'POST /api/cloud/link/check',
      'POST /api/cloud/link/start',
      'POST /api/cloud/seats/:seatId/assign',
      'POST /api/cloud/seats/:seatId/release',
      'POST /api/cloud/unlink',
      'PUT /api/cloud/credits/default',
    ],
  ],
  [
    'connections are the hub’s',
    [
      'ALL /api/communities/*',
      'ALL /api/community-connections/*',
      'ALL /api/connectors/*',
      'ALL /api/connectors/connections/:connectionId/events',
      'ALL /api/connectors/connections/:connectionId/events/*',
      'ALL /api/connectors/providers/*',
      'DELETE /api/communities/:ref/agents/:localAgentId',
      'DELETE /api/communities/:ref/rooms/:roomId/agents/:localAgentId/membership',
      'DELETE /api/communities/:ref/rooms/:roomId/membership',
      'DELETE /api/community-connections/:ref',
      'DELETE /api/connectors/connections/:connectionId',
      'DELETE /api/connectors/connections/:connectionId/events/subscriptions/:subscriptionId',
      'DELETE /api/connectors/connections/:connectionId/every-agent',
      'DELETE /api/connectors/providers/:provider/credential',
      'DELETE /api/relay/adapters/:id',
      'DELETE /api/relay/bindings/:id',
      'DELETE /api/relay/dead-letters',
      'DELETE /api/relay/endpoints/:subject{.+}',
      'PATCH /api/connectors/connections/:connectionId',
      'PATCH /api/relay/adapters/:id/config',
      'PATCH /api/relay/bindings/:id',
      'POST /api/communities/:ref/agents/:localAgentId/enroll',
      'POST /api/communities/:ref/dms',
      'POST /api/communities/:ref/rooms/:roomId/agents/:localAgentId/halt',
      'POST /api/communities/:ref/rooms/:roomId/agents/:localAgentId/membership',
      'POST /api/communities/:ref/rooms/:roomId/attachments',
      'POST /api/communities/:ref/rooms/:roomId/deliveries/:idempotencyKey/retry',
      'POST /api/communities/:ref/rooms/:roomId/entries',
      'POST /api/communities/:ref/rooms/:roomId/entries/:entryId/reports',
      'POST /api/communities/:ref/rooms/:roomId/halt',
      'POST /api/communities/:ref/rooms/:roomId/membership',
      'POST /api/communities/:ref/rules/accept',
      'POST /api/community-connections',
      'POST /api/community-connections/:ref/cancel',
      'POST /api/community-connections/:ref/poll',
      'POST /api/community-connections/navigation/move',
      'POST /api/connectors/agent-requests/:requestId/authentication-flows',
      'POST /api/connectors/agent-requests/:requestId/decision',
      'POST /api/connectors/cli/executions',
      'POST /api/connectors/connections',
      'POST /api/connectors/connections/:connectionId/events/subscriptions',
      'POST /api/connectors/connections/:connectionId/pause',
      'POST /api/connectors/connections/:connectionId/reconnect',
      'POST /api/connectors/connections/:connectionId/remove',
      'POST /api/connectors/connections/:connectionId/resume',
      'POST /api/connectors/executions',
      'POST /api/connectors/holds/:holdId/cancel',
      'POST /api/connectors/reconciliation/apply',
      'POST /api/connectors/reconciliation/previews',
      'POST /api/connectors/reviews',
      'POST /api/connectors/reviews/:reviewRequestId/decision',
      'POST /api/connectors/webhooks/:providerInstanceId',
      'POST /api/relay/adapters',
      'POST /api/relay/adapters/:id/disable',
      'POST /api/relay/adapters/:id/enable',
      'POST /api/relay/adapters/reload',
      'POST /api/relay/adapters/test',
      'POST /api/relay/bindings',
      'POST /api/relay/bindings/:id/move',
      'POST /api/relay/bindings/:id/test',
      'POST /api/relay/endpoints',
      'POST /api/relay/messages',
      'POST /api/relay/unclaimed-chats/:id/block',
      'POST /api/relay/unclaimed-chats/:id/claim',
      'POST /api/relay/unclaimed-chats/:id/ignore',
      'POST /api/relay/unclaimed-chats/:id/leave',
      'POST /api/relay/webhooks/:adapterId',
      'PUT /api/communities/:ref/agents/:localAgentId/dms',
      'PUT /api/communities/:ref/me/display-name',
      'PUT /api/communities/:ref/rooms/:roomId/read-cursor',
      'PUT /api/community-connections/:ref/answer-in',
      'PUT /api/community-connections/:ref/wake-agents-from',
      'PUT /api/community-connections/navigation/destination',
      'PUT /api/community-connections/navigation/installation',
      'PUT /api/connectors/connections/:connectionId/events/source',
      'PUT /api/connectors/providers/:provider/credential',
      'PUT /api/connectors/sessions/:sessionId/connections/:connectionId',
      'PUT /api/community-connections/:ref/teammate-spend',
    ],
  ],
  [
    'a person’s window or own browser, which nobody opens here',
    [
      'ALL /api/docs',
      'ALL /api/docs/*',
      'ALL /api/feedback/*',
      'ALL /api/local-browser/*',
      'PATCH /api/notifications/:id/read',
      'POST /api/diff/baseline/advance',
      'POST /api/diff/revert',
      'POST /api/direct-chats',
      'POST /api/errors',
      'POST /api/feedback',
      'POST /api/files/reveal',
      'POST /api/local-browser/disconnect',
      'POST /api/local-browser/navigate',
      'POST /api/local-browser/open',
      'POST /api/local-browser/pause',
      'POST /api/local-browser/resume',
      'POST /api/local-browser/tabs/:id/select',
      'POST /api/notifications/read-all',
      'POST /api/workbench/probe',
      'POST /api/workbench/sign',
      'PUT /api/read-cursors/:kind/:id',
      'POST /api/sessions/:id/stream-health',
      'POST /api/workbench/bridge',
      // A comment the person typed in a mini app, forwarded as their words,
      // and the choice of who may receive it (DOR-3325): signed-in person only.
      'POST /api/extensions/:id/forward',
      'POST /api/extensions/:id/forward/pending/:pendingId/allow',
      'POST /api/extensions/:id/forward/pending/:pendingId/decline',
      'PUT /api/extensions/:id/forward-agents',
    ],
  ],
  [
    'extensions are the hub’s',
    [
      'ALL /api/ext/:id',
      'ALL /api/ext/:id/*',
      'DELETE /api/extensions/:id/secrets/:key',
      'DELETE /api/extensions/:id/settings/:key',
      'DELETE /api/extensions/trusted-sources',
      'POST /api/extension-decisions/:id/action',
      'POST /api/extension-decisions/:id/offer',
      'POST /api/extensions/:id/approve',
      'POST /api/extensions/:id/decisions/:decisionId/action',
      'POST /api/extensions/:id/disable',
      'POST /api/extensions/:id/dismiss-approval',
      'POST /api/extensions/:id/enable',
      'POST /api/extensions/:id/init-server',
      'POST /api/extensions/:id/revoke',
      'POST /api/extensions/:id/start-work',
      'POST /api/extensions/cwd-changed',
      'POST /api/extensions/reload',
      'POST /api/extensions/trusted-sources',
      'PUT /api/extensions/:id/data',
      'PUT /api/extensions/:id/project-settings',
      'PUT /api/extensions/:id/secrets/:key',
      'PUT /api/extensions/:id/settings/:key',
      'POST /api/extensions/:id/rooms/:roomId/threads/:entryId/replies',
      'PUT /api/extensions/:id/room-access',
      'PUT /api/extensions/:id/rooms/:roomId/threads/:entryId/read',
    ],
  ],
  [
    'a hub’s own routes, not an agent computer’s',
    [
      'ALL /api/hub/computers/*',
      'DELETE /api/hub/computers/:computerId',
      'POST /api/hub/computers/:computerId/sessions/:sessionId/answers',
      'POST /api/hub/computers/:computerId/sessions/:sessionId/interrupt',
      'POST /api/hub/computers/:computerId/sessions/:sessionId/messages',
      'POST /api/hub/computers/link-code',
      'POST /api/hub/link',
    ],
  ],
  [
    'where work runs is the hub’s',
    [
      'ALL /api/session-locations/*',
      'DELETE /api/workspaces/:id',
      'POST /api/directory',
      'POST /api/discovery/scan',
      'POST /api/session-locations',
      'POST /api/workspaces',
      'POST /api/workspaces/:id/pin',
      'POST /api/workspaces/ports',
    ],
  ],
  [
    'remote access and sign-in are the hub’s',
    [
      'ALL /api/session-relay/*',
      'ALL /api/sign-in-landings/*',
      'DELETE /api/session-relay/link',
      'PATCH /api/session-relay/level',
      'POST /api/desktop/sign-in',
      'POST /api/lan-access',
      'POST /api/remote-access/close',
      'POST /api/remote-access/enrolment',
      'POST /api/remote-access/mode',
      'POST /api/remote-access/withdraw',
      'POST /api/session-relay/link',
      'POST /api/session-relay/pause',
      'POST /api/session-relay/presence/end',
      'POST /api/session-relay/resume',
      'POST /api/sign-in-landings/:id/retry',
      'POST /api/tunnel/start',
      'POST /api/tunnel/stop',
      'ALL /api/devices/*',
      'DELETE /api/devices/sessions/:id',
      'POST /api/devices/sign-out-all',
      'DELETE /api/session-relay/passkeys',
      'DELETE /api/session-relay/passkeys/:credentialId',
      'POST /api/session-relay/passkeys/finish',
      'POST /api/session-relay/passkeys/start',
    ],
  ],
  [
    'a person’s decision on a session (approving, settings, continuing) or the window',
    [
      'ALL /api/sessions/:id/*',
      'DELETE /api/sessions/:id/canvas/:documentId',
      'PATCH /api/sessions/:id',
      'PATCH /api/sessions/:id/canvas/:documentId',
      'POST /api/sessions/:id/approve',
      'POST /api/sessions/:id/batch-approve',
      'POST /api/sessions/:id/batch-deny',
      'POST /api/sessions/:id/canvas',
      'POST /api/sessions/:id/canvas/:documentId/editing',
      'POST /api/sessions/:id/command-intents/:intent',
      'POST /api/sessions/:id/continue',
      'POST /api/sessions/:id/continue/cancel',
      'POST /api/sessions/:id/deny',
      'POST /api/sessions/:id/devtools/action',
      'POST /api/sessions/:id/devtools/ingest',
      'POST /api/sessions/:id/devtools/recording',
      'POST /api/sessions/:id/fork',
      'POST /api/sessions/:id/mcp-app/resource',
      'POST /api/sessions/:id/opened',
      'POST /api/sessions/:id/process/switch',
      'POST /api/sessions/:id/reload-plugins',
      'POST /api/sessions/:id/ui-action',
      'POST /api/sessions/:id/wait',
    ],
  ],
  [
    'test-mode controls, never an agent’s',
    [
      'ALL /api/test/mcp-oauth/mcp',
      'POST /api/test/agent-token',
      'POST /api/test/canonical-id',
      'POST /api/test/community-connection-change',
      'POST /api/test/composio/emit',
      'POST /api/test/composio/events-state',
      'POST /api/test/connectors/execute-read',
      'POST /api/test/connectors/request',
      'POST /api/test/fake-inference/v1/chat/completions',
      'POST /api/test/finish-turn',
      'POST /api/test/heartbeat/beat',
      'POST /api/test/interrupt-outcome',
      'POST /api/test/mcp-oauth/register',
      'POST /api/test/mcp-oauth/token',
      'POST /api/test/persistent',
      'POST /api/test/probe-mcp-oauth-server',
      'POST /api/test/reap',
      'POST /api/test/reset',
      'POST /api/test/room-worktree-commit',
      'POST /api/test/scenario',
      'POST /api/test/seed-agent',
      'POST /api/test/seed-approval',
      'POST /api/test/seed-bridge',
      'POST /api/test/seed-oauth-mcp-agent',
      'POST /api/test/step',
      'DELETE /api/test/account-world',
      'PUT /api/test/account-world',
      'POST /api/test/doc-routes/configure',
    ],
  ],
  [
    'what is installed is the hub’s',
    [
      'DELETE /api/marketplace/cache',
      'DELETE /api/marketplace/sources/:name',
      'DELETE /api/templates/:id',
      'POST /api/harness/adopt',
      'POST /api/harness/sync',
      'POST /api/marketplace/cache/prune',
      'POST /api/marketplace/dev-links',
      'POST /api/marketplace/dev-links/:name/unlink',
      'POST /api/marketplace/dev-links/preview',
      'POST /api/marketplace/held-back/:name/decision',
      'POST /api/marketplace/held-back/:name/review',
      'POST /api/marketplace/packages/:name/check-files',
      'POST /api/marketplace/packages/:name/install',
      'POST /api/marketplace/packages/:name/keep-files',
      'POST /api/marketplace/packages/:name/preview',
      'POST /api/marketplace/packages/:name/uninstall',
      'POST /api/marketplace/packages/:name/update',
      'POST /api/marketplace/sources',
      'POST /api/marketplace/sources/:name/refresh',
      'POST /api/marketplace/updates',
      'DELETE /api/mcp-servers/:name',
      'PATCH /api/mcp-servers/:name',
      'POST /api/mcp-servers',
      'PUT /api/mcp-servers/:name',
      'POST /api/shapes/:name/apply',
      'POST /api/shapes/:name/fork',
      'POST /api/templates',
    ],
  ],
  [
    'who the agents are is the hub’s',
    [
      'DELETE /api/mesh/agents/:id',
      'DELETE /api/mesh/agents/:id/data',
      'DELETE /api/mesh/denied/:encodedPath',
      'PATCH /api/agents/:id/permissions',
      'PATCH /api/agents/current',
      // Pausing stays open (anyone may stop any agent); resuming one a person
      // paused is that person's call, never an agent's.
      'POST /api/agents/:id/resume',
      'PATCH /api/mesh/agents/:id',
      'POST /api/agents',
      'POST /api/agents/create',
      'POST /api/agents/current/migrate-persona',
      'POST /api/mesh/agents',
      'POST /api/mesh/deny',
      'PUT /api/mesh/topology/access',
    ],
  ],
  [
    'settings are the hub’s',
    [
      'DELETE /api/profile/avatar',
      'DELETE /api/profile/identities/:authorId',
      'DELETE /api/push/subscriptions/:id',
      'PATCH /api/config',
      'PATCH /api/profile',
      'POST /api/config/mcp/reveal-token',
      'POST /api/config/mcp/rotate-token',
      'POST /api/onboarding/first-run',
      'POST /api/onboarding/welcome',
      'POST /api/profile/avatar',
      'POST /api/profile/identities/:authorId',
      'POST /api/push/subscriptions',
      'PUT /api/config/agents/defaultAgent',
      'PUT /api/heartbeats/triage-credits',
    ],
  ],
  [
    'a room’s members, settings, repo and watchers are a person’s',
    [
      'DELETE /api/rooms/:id/follow',
      'DELETE /api/rooms/:id/members/:authorId',
      'PATCH /api/rooms/:id',
      'PATCH /api/rooms/:id/members/:authorId',
      'PATCH /api/rooms/authors/:authorId/handle',
      'POST /api/rooms',
      'POST /api/rooms/:id/canvas/viewing',
      'POST /api/rooms/:id/follow/view',
      'POST /api/rooms/:id/holds/:authorId/promote',
      'POST /api/rooms/:id/members',
      'POST /api/rooms/:id/repo',
      'POST /api/rooms/:id/repo/main/repair',
      'POST /api/rooms/:id/repo/merge',
      'PUT /api/rooms/:id/canvas/:documentId/diff',
      'PUT /api/rooms/:id/files/content',
      'PUT /api/rooms/:id/follow',
      'POST /api/rooms/:id/members/:authorId/reseat',
    ],
  ],
  [
    'schedules are the hub’s',
    [
      'DELETE /api/tasks/:id',
      'PATCH /api/tasks/:id',
      'POST /api/tasks',
      'POST /api/tasks/:id/trigger',
      'POST /api/tasks/runs/:id/cancel',
    ],
  ],
  [
    'permissions and approvals are a person’s',
    [
      'PATCH /api/permissions/defaults',
      'POST /api/approvals/:id/deny',
      'POST /api/approvals/:id/dismiss-suggestion',
      'POST /api/approvals/:id/grant',
      'POST /api/permissions/history/:eventId/undo',
      'PUT /api/permissions/preset',
      'POST /api/canvas/docs/:id/routes/:routeId/approve',
      'POST /api/canvas/docs/:id/routes/:routeId/review',
      'POST /api/canvas/docs/:id/routes/:routeId/revoke',
      'POST /api/canvas/docs/:id/work/:batchId/clear',
      'POST /api/canvas/docs/:id/work/:batchId/replay',
    ],
  ],
  [
    'runtime sign-ins are the hub’s',
    [
      'POST /api/runtimes/:type/credential',
      'POST /api/runtimes/:type/credential/check',
      'POST /api/runtimes/:type/login',
      'POST /api/runtimes/claude-code/accounts/:id/probe',
      'POST /api/runtimes/claude-code/accounts/found/dismiss',
      'POST /api/runtimes/claude-code/project-accounts/without-credits',
      'POST /api/runtimes/claude-code/provision',
      'POST /api/runtimes/codex/provision',
      'POST /api/runtimes/doe/credential',
      'POST /api/runtimes/opencode/ollama/provision',
      'POST /api/runtimes/opencode/ollama/pull',
      'POST /api/runtimes/opencode/openrouter/key',
      'POST /api/runtimes/opencode/openrouter/oauth/start',
      'POST /api/runtimes/opencode/provider/credential',
      'POST /api/runtimes/opencode/provider/credential/check',
      'POST /api/runtimes/opencode/provision',
      'PUT /api/runtimes/claude-code/accounts/:id/only-projects',
      'PUT /api/runtimes/claude-code/project-accounts',
      'PUT /api/runtimes/doe/inference',
      'PUT /api/runtimes/claude-code/accounts/:id/no-auto-move',
    ],
  ],
];

/** The write methods an `ALL` route answers. */
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** One concrete request a census route serves: each parameter or wildcard filled in. */
function requestsFor(route: string): [method: string, path: string][] {
  const [method, pattern] = route.split(' ') as [string, string];
  const concrete = pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? 'p1' : segment === '*' ? 'x' : segment))
    .join('/');
  const methods = method === 'ALL' ? WRITE_METHODS : [method];
  return methods.map((m) => [m, concrete]);
}

const AS_AGENT = { host: '127.0.0.1:4242', 'x-dorkos-agent': 'agent-live' };
const refused = REFUSED.flatMap(([, routes]) => routes);

beforeEach(() => {
  role.value = 'agent-computer';
});

describe('the write census', () => {
  it('classifies every write route exactly once', () => {
    const classified = [...AGENT_COMPUTER_WRITES.keys(), ...OWN_AUTHORIZER.keys(), ...refused];
    const unclassified = WRITE_ROUTES.filter((route) => !classified.includes(route));
    // A new write route lands here: add it to AGENT_COMPUTER_WRITES with why an
    // agent needs it, or to REFUSED with why it is the hub's or a person's.
    expect(unclassified).toEqual([]);
    const twice = classified.filter((route, i) => classified.indexOf(route) !== i);
    expect(twice).toEqual([]);
  });

  it('names only routes the server serves', () => {
    const classified = [...AGENT_COMPUTER_WRITES.keys(), ...OWN_AUTHORIZER.keys(), ...refused];
    expect(classified.filter((route) => !WRITE_ROUTES.includes(route))).toEqual([]);
  });

  it('gives every open write a reason', () => {
    for (const [route, reason] of AGENT_COMPUTER_WRITES) expect(reason, route).not.toBe('');
  });
});

describe('the gate, asked about every write route', () => {
  it.each([...AGENT_COMPUTER_WRITES.keys(), ...OWN_AUTHORIZER.keys()])(
    'lets an agent %s',
    async (route) => {
      for (const [method, path] of requestsFor(route)) {
        const decision = await decideAgentComputerGate(method, path, AS_AGENT);
        expect(decision.allowed, `${method} ${path}`).toBe(true);
      }
    }
  );

  it.each(refused)('refuses an agent %s', async (route) => {
    for (const [method, path] of requestsFor(route)) {
      const decision = await decideAgentComputerGate(method, path, AS_AGENT);
      expect(decision.allowed, `${method} ${path}`).toBe(false);
    }
  });

  it('refuses with one code, never asking again', async () => {
    expect(await decideAgentComputerGate('POST', '/api/relay/adapters', AS_AGENT)).toEqual({
      allowed: false,
      refusal: {
        error: 'This is an agent computer. Only its hub makes this change.',
        code: 'AGENT_COMPUTER_HUB_OWNED',
      },
    });
  });

  it('refuses a write method it has never heard of, and no read', () => {
    expect(agentComputerRouteRefusal('PROPFIND', '/api/files')).not.toBeNull();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(agentComputerRouteRefusal(method, '/api/config'), method).toBeNull();
    }
  });

  it('refuses no write on another role', () => {
    for (const value of ['computer', 'hub'] as const) {
      role.value = value;
      for (const [method, path] of refused.flatMap(requestsFor)) {
        expect(agentComputerRouteRefusal(method, path), `${value} ${method} ${path}`).toBeNull();
      }
    }
  });
});
