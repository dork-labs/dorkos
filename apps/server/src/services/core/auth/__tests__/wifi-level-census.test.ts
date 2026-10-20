/**
 * Every write route the server mounts, classified for the Wi-Fi level
 * (DOR-2969 part 3): either the Wi-Fi list refuses it, or it is named below as
 * allowed on Wi-Fi, under a one-line reason. A new write route fails here
 * until somebody decides which.
 *
 * The inventory is the route census baseline (`http/__tests__/route-census.
 * baseline.json`), which `route-census.test.ts` holds equal to the routes the
 * real composed server serves, so a route cannot be added without landing here.
 */
import { describe, expect, it } from 'vitest';

import census from '../../../../http/__tests__/route-census.baseline.json' with { type: 'json' };
import { matchWifiRefusedRoute } from '../sessions/wifi-level.js';

/**
 * Write routes a Wi-Fi sign-in keeps, by why. Each entry is a census line,
 * exactly as the baseline spells it.
 */
const ALLOWED_ON_WIFI: Readonly<Record<string, readonly string[]>> = {
  'Chat: sending, steering and answering inside a chat, at the chat’s own level': [
    'POST /api/direct-chats',
    'POST /api/sessions/:id/opened',
    'POST /api/sessions/:id/interrupt',
    'POST /api/sessions/:id/wait',
    'POST /api/sessions/:id/fork',
    'POST /api/sessions/:id/continue/cancel',
    // Moving a room agent to another account (re-seat): the room twin of
    // continuing a chat on another account, two lines up, so the same level.
    'POST /api/rooms/:id/members/:authorId/reseat',
    'POST /api/sessions/:id/command-intents/:intent',
    'POST /api/sessions/:id/process/switch',
    'POST /api/sessions/:id/reload-plugins',
    'POST /api/sessions/:id/submit-answers',
    'POST /api/sessions/:id/submit-elicitation',
    'POST /api/sessions/:id/tasks/:taskId/stop',
    'POST /api/sessions/:id/mcp-app/resource',
    'POST /api/sessions/:id/devtools/action',
    'POST /api/sessions/:id/devtools/ingest',
    'POST /api/sessions/:id/devtools/recording',
    'DELETE /api/sessions/:id/queue/:messageId',
    'POST /api/sessions/:id/canvas',
    'POST /api/sessions/:id/canvas/:documentId/editing',
    'PATCH /api/sessions/:id/canvas/:documentId',
    'DELETE /api/sessions/:id/canvas/:documentId',
    'POST /api/uploads',
    'POST /api/canvas/docs/:id/events',
    'POST /api/session-locations',
  ],
  'Rooms: talking in a room and running it, the same chat level': [
    'POST /api/rooms',
    'PATCH /api/rooms/:id',
    'POST /api/rooms/:id/entries/:entryId/reactions',
    'POST /api/rooms/:id/attachments',
    'POST /api/rooms/:id/members',
    'PATCH /api/rooms/:id/members/:authorId',
    'DELETE /api/rooms/:id/members/:authorId',
    'PATCH /api/rooms/authors/:authorId/handle',
    'POST /api/rooms/:id/halt',
    'POST /api/rooms/:id/halt/:authorId',
    'POST /api/rooms/:id/holds/:authorId/promote',
    'PUT /api/rooms/:id/follow',
    'DELETE /api/rooms/:id/follow',
    'POST /api/rooms/:id/follow/view',
    'POST /api/rooms/:id/canvas',
    'POST /api/rooms/:id/canvas/viewing',
    'POST /api/rooms/:id/canvas/:documentId/editing',
    'POST /api/rooms/:id/canvas/:documentId/thread',
    'PATCH /api/rooms/:id/canvas/:documentId',
    'DELETE /api/rooms/:id/canvas/:documentId',
  ],
  'Communities: chat in a community this computer already belongs to': [
    'POST /api/communities/:ref/dms',
    'PUT /api/communities/:ref/agents/:localAgentId/dms',
    'POST /api/communities/:ref/agents/:localAgentId/enroll',
    'DELETE /api/communities/:ref/agents/:localAgentId',
    'PUT /api/communities/:ref/me/display-name',
    'POST /api/communities/:ref/rules/accept',
    'POST /api/communities/:ref/rooms/:roomId/entries',
    'POST /api/communities/:ref/rooms/:roomId/entries/:entryId/reports',
    'POST /api/communities/:ref/rooms/:roomId/attachments',
    'POST /api/communities/:ref/rooms/:roomId/deliveries/:idempotencyKey/retry',
    'POST /api/communities/:ref/rooms/:roomId/halt',
    'POST /api/communities/:ref/rooms/:roomId/membership',
    'DELETE /api/communities/:ref/rooms/:roomId/membership',
    'POST /api/communities/:ref/rooms/:roomId/agents/:localAgentId/halt',
    'POST /api/communities/:ref/rooms/:roomId/agents/:localAgentId/membership',
    'DELETE /api/communities/:ref/rooms/:roomId/agents/:localAgentId/membership',
    'PUT /api/communities/:ref/rooms/:roomId/read-cursor',
    'POST /api/community-connections',
    'DELETE /api/community-connections/:ref',
    'POST /api/community-connections/:ref/cancel',
    'POST /api/community-connections/:ref/poll',
    'PUT /api/community-connections/:ref/answer-in',
    'PUT /api/community-connections/:ref/wake-agents-from',
    'POST /api/community-connections/navigation/move',
    'PUT /api/community-connections/navigation/destination',
    'PUT /api/community-connections/navigation/installation',
    'POST /api/cloud/communities',
    'POST /api/cloud/communities/:communityId/claim-link',
    'POST /api/cloud/communities/:communityId/keep',
    'POST /api/cloud/communities/:communityId/restore',
    'POST /api/cloud/communities/moves',
    'POST /api/cloud/communities/moves/:moveId/cancel',
    'POST /api/cloud/communities/moves/:moveId/upload',
  ],
  'Answers: approvals and agent questions; a destructive yes and act/destructive calls are refused in the route':
    [
      'POST /api/approvals/:id/grant',
      'POST /api/approvals/:id/deny',
      'POST /api/approvals/:id/dismiss-suggestion',
      'POST /api/sessions/:id/approve',
      'POST /api/sessions/:id/deny',
      'POST /api/sessions/:id/batch-approve',
      'POST /api/sessions/:id/batch-deny',
      'POST /api/capabilities/:id/invoke',
      'POST /api/connectors/reviews',
      'POST /api/connectors/reviews/:reviewRequestId/decision',
      'POST /api/connectors/holds/:holdId/cancel',
      'POST /api/extension-decisions/:id/action',
      'POST /api/extension-decisions/:id/offer',
      'POST /api/extensions/:id/decisions/:decisionId/action',
      'PUT /api/connectors/sessions/:sessionId/connections/:connectionId',
    ],
  'Read-ish marks: read cursors, dismissals, views and previews that change no power': [
    'PUT /api/read-cursors/:kind/:id',
    'PUT /api/extensions/:id/rooms/:roomId/threads/:entryId/read',
    'PATCH /api/notifications/:id/read',
    'POST /api/notifications/read-all',
    'POST /api/diff/baseline/advance',
    'POST /api/discovery/scan',
    'POST /api/agents/resolve',
    'POST /api/workspaces/ports',
    'POST /api/workspaces/:id/pin',
    'POST /api/workbench/probe',
    'POST /api/workbench/bridge',
    'POST /api/workbench/sign',
    'POST /api/marketplace/packages/:name/preview',
    'POST /api/marketplace/packages/:name/check-files',
    'POST /api/marketplace/held-back/:name/review',
    'POST /api/marketplace/cache/prune',
    'DELETE /api/marketplace/cache',
    'POST /api/shapes/:name/fork',
    'POST /api/extensions/cwd-changed',
    'PUT /api/extensions/:id/data',
    'POST /api/cloud/credits/notices/dismiss',
    'POST /api/cloud/link/cancel',
    'POST /api/cloud/link/check',
    'POST /api/sign-in-landings/:id/retry',
    'POST /api/errors',
    'POST /api/feedback',
    'DELETE /api/relay/dead-letters',
    'POST /api/relay/unclaimed-chats/:id/block',
    'POST /api/relay/unclaimed-chats/:id/ignore',
    'POST /api/relay/unclaimed-chats/:id/leave',
    'POST /api/mesh/agents/:id/heartbeat',
  ],
  'Your own things: profile, this device’s notifications, your own sign-out': [
    'PATCH /api/profile',
    'POST /api/profile/avatar',
    'DELETE /api/profile/avatar',
    'POST /api/profile/identities/:authorId',
    'DELETE /api/profile/identities/:authorId',
    'POST /api/push/subscriptions',
    'DELETE /api/push/subscriptions/:id',
    'DELETE /api/devices/sessions/:id',
  ],
  'Work and agents at the chat level: tasks, commitments, pausing, agent settings': [
    'DELETE /api/tasks/:id',
    'POST /api/tasks/runs/:id/cancel',
    'PATCH /api/commitments/:id',
    'POST /api/agents/:id/pause',
    'POST /api/agents/:id/resume',
    'PATCH /api/agents/current',
    'PUT /api/config/agents/defaultAgent',
  ],
  'Starts a turn: from Wi-Fi it runs at the runtime’s default at most, Allow once only (DOR-3037)':
    [
      'POST /api/sessions/:id/messages',
      'POST /api/sessions/:id/continue',
      'POST /api/sessions/:id/ui-action',
      'PATCH /api/sessions/:id/queue/:messageId',
      'POST /api/rooms/:id/entries',
      'POST /api/rooms/:id/threads',
      // A mini app's reply as the person, in a room picked at the computer (DOR-3017).
      'POST /api/extensions/:id/rooms/:roomId/threads/:entryId/replies',
      'POST /api/extensions/:id/start-work',
      'POST /api/relay/messages',
    ],
  'Lower only on Wi-Fi: the route refuses a raise and allows a lower; Undo is refused (DOR-3037)': [
    'PATCH /api/sessions/:id',
    'POST /api/tasks',
    'PATCH /api/tasks/:id',
    'POST /api/tasks/:id/trigger',
    'PATCH /api/permissions/defaults',
    'PUT /api/permissions/preset',
    'PATCH /api/agents/:id/permissions',
    'POST /api/permissions/history/:eventId/undo',
  ],
  'Settings: front-door settings refused by the route; a looser Files & commands stop too (DOR-3037)':
    ['PATCH /api/config'],
  'The account: spending and billing, held to the owner bar; the key itself is refused': [
    'PUT /api/cloud/credits/default',
    'POST /api/cloud/credits/undo-filled',
    'PUT /api/heartbeats/triage-credits',
    'POST /api/cloud/billing/:page',
    'POST /api/cloud/account/export',
    'POST /api/cloud/account/deletion',
    'POST /api/cloud/seats/:seatId/assign',
    'POST /api/cloud/seats/:seatId/release',
  ],
  'Settings: front-door settings in the body are refused by the route itself': [
    'PATCH /api/config',
  ],
  'Document routes: reviewing and turning off only narrow; allowing one is a standing route, so the route itself refuses Wi-Fi':
    [
      'POST /api/canvas/docs/:id/routes/:routeId/review',
      'POST /api/canvas/docs/:id/routes/:routeId/approve',
      'POST /api/canvas/docs/:id/routes/:routeId/revoke',
    ],
  'Document work review: one run under a route that is already allowed, or clearing it, which only narrows':
    [
      'POST /api/canvas/docs/:id/work/:batchId/replay',
      'POST /api/canvas/docs/:id/work/:batchId/clear',
    ],
  'Already this computer only: the route refuses every other caller': [
    'POST /api/desktop/sign-in',
    'POST /api/onboarding/first-run',
    'POST /api/onboarding/welcome',
    'POST /api/local-browser/open',
    'POST /api/local-browser/navigate',
    'POST /api/local-browser/pause',
    'POST /api/local-browser/resume',
    'POST /api/local-browser/disconnect',
    'POST /api/local-browser/tabs/:id/select',
  ],
  'Inbound and signed: a provider’s webhook, never a person on Wi-Fi': [
    'POST /api/connectors/webhooks/:providerInstanceId',
    'POST /api/relay/webhooks/:adapterId',
  ],
  'Hub only: a hub has no Wi-Fi route': [
    'POST /api/hub/link',
    'POST /api/hub/computers/link-code',
    'DELETE /api/hub/computers/:computerId',
    'POST /api/hub/computers/:computerId/sessions/:sessionId/messages',
    'POST /api/hub/computers/:computerId/sessions/:sessionId/interrupt',
    'POST /api/hub/computers/:computerId/sessions/:sessionId/answers',
  ],
};

/**
 * `ALL` lines: group middleware and whole-group handlers, not one write.
 * Their writes are listed one by one; the few handlers are named.
 */
const MOUNTS: Readonly<Record<string, string>> = {
  'ALL /api/admin/*': 'Group middleware; its writes are refused one by one.',
  'ALL /api/auth/*': 'Better Auth; its key, password and sign-out writes are refused by path.',
  'ALL /api/canvas/docs/*': 'Group middleware for shared documents.',
  'ALL /api/cloud/communities/*': 'Group middleware for hosted communities.',
  'ALL /api/communities/*': 'Group middleware for community rooms.',
  'ALL /api/community-connections/*': 'Group middleware for community membership.',
  'ALL /api/connectors/*': 'Group middleware; connected-app writes are refused by path.',
  'ALL /api/connectors/connections/:connectionId/events': 'An app’s event stream.',
  'ALL /api/connectors/connections/:connectionId/events/*': 'An app’s event stream.',
  'ALL /api/connectors/providers/*': 'Group middleware; stored keys are refused by path.',
  'ALL /api/devices/*': 'Group middleware; sign-out-all is refused by path.',
  'ALL /api/docs': 'The API reference, read only.',
  'ALL /api/docs/*': 'The API reference, read only.',
  'ALL /api/ext/:id': 'An extension’s own page; extensions are turned on at the computer.',
  'ALL /api/ext/:id/*': 'An extension’s own page; extensions are turned on at the computer.',
  'ALL /api/feedback/*': 'Group middleware for feedback.',
  'ALL /api/hub/computers/*': 'Hub only: a hub has no Wi-Fi route.',
  'ALL /api/local-browser/*': 'Group middleware; every route is this computer only.',
  'ALL /api/session-locations/*': 'Group middleware for where chats live.',
  'ALL /api/session-relay/*': 'Group middleware; its writes are refused by path.',
  'ALL /api/sessions/:id/*': 'Group middleware for a chat.',
  'ALL /api/sign-in-landings/*': 'Group middleware for sign-in landing pages.',
  'ALL /api/test/mcp-oauth/mcp': 'Test runtime only.',
  'ALL /mcp': 'Agent tools; a cookie is refused there, a key decides.',
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A census path with every parameter filled in, as a request would name it. */
function samplePath(path: string): string {
  return path.replace(/:[A-Za-z]+(?:\{[^}]*\})?/g, 'x');
}

const routes = census.routes as string[];
const allowed = new Map(
  Object.entries(ALLOWED_ON_WIFI).flatMap(([reason, list]) =>
    list.map((route) => [route, reason] as const)
  )
);

describe('every write route is classified for the Wi-Fi level', () => {
  const writes = routes.filter((route) => WRITE_METHODS.has(route.split(' ')[0]!));
  // Test-only routes are mounted only under the test runtime.
  const product = writes.filter((route) => !route.includes(' /api/test/'));

  it.each(product)('%s', (route) => {
    const [method, path] = route.split(' ') as [string, string];
    const refused = matchWifiRefusedRoute(method, [samplePath(path)], false) !== undefined;
    // Exactly one: refused by the list, or allowed with a reason. Never both.
    expect({ refused, allowed: allowed.has(route) }).toEqual(
      refused ? { refused: true, allowed: false } : { refused: false, allowed: true }
    );
  });

  it('classifies every group mount', () => {
    const mounts = routes.filter((route) => route.startsWith('ALL '));
    expect(mounts.filter((route) => MOUNTS[route] === undefined)).toEqual([]);
  });

  it('names no route the server no longer serves', () => {
    const served = new Set(routes);
    expect([...allowed.keys(), ...Object.keys(MOUNTS)].filter((r) => !served.has(r))).toEqual([]);
  });

  it('keeps the refused set from collapsing: most writes that matter stay refused', () => {
    const refused = product.filter((route) => {
      const [method, path] = route.split(' ') as [string, string];
      return matchWifiRefusedRoute(method, [samplePath(path)], false) !== undefined;
    });
    expect(refused.length).toBeGreaterThan(60);
  });
});
