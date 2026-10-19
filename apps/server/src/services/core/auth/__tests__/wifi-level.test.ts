/**
 * The Wi-Fi level's one list (F4 part 3, DOR-2969): every refused route, for
 * every caller kind, with every way a router might spell its path, and the
 * surfaces a Wi-Fi sign-in keeps.
 */
import { describe, expect, it } from 'vitest';

import {
  matchWifiRefusedRoute,
  NOT_FROM_WIFI,
  WIFI_REFUSED_ROUTES,
  wifiLevelRefusal,
  type WifiRefusedSurface,
} from '../sessions/wifi-level.js';
import type { RequestIngress } from '../../remote/ingress-mark.js';

/** One request each refused route must refuse: its method and path. */
const REFUSED: readonly [WifiRefusedSurface, string, string][] = [
  ['terminal', 'POST', '/api/terminal'],
  ['terminal', 'DELETE', '/api/terminal/term-1'],
  ['terminal', 'GET', '/api/terminal/term-1/socket'],
  ['file-writes', 'PUT', '/api/files/content'],
  ['file-writes', 'POST', '/api/files'],
  ['file-writes', 'DELETE', '/api/files'],
  ['file-writes', 'POST', '/api/files/rename'],
  ['file-writes', 'POST', '/api/files/copy'],
  ['file-writes', 'POST', '/api/files/reveal'],
  ['file-writes', 'PUT', '/api/rooms/r1/files/content'],
  ['file-writes', 'POST', '/api/rooms/r1/files/upload'],
  ['file-writes', 'POST', '/api/rooms/r1/files/move'],
  ['file-writes', 'POST', '/api/rooms/r1/files/delete'],
  ['file-writes', 'POST', '/api/rooms/r1/files/from-attachment'],
  ['file-writes', 'POST', '/api/canvas/docs/d1/file-saves/e1/recover'],
  ['api-keys', 'POST', '/api/auth/api-key/create'],
  ['api-keys', 'POST', '/api/auth/api-key/update'],
  ['api-keys', 'POST', '/api/auth/api-key/delete'],
  ['api-keys', 'GET', '/api/auth/api-key/list'],
  ['mcp', 'POST', '/mcp'],
  ['a2a', 'POST', '/a2a'],
  ['a2a', 'POST', '/a2a/agents/a1'],
  ['a2a', 'GET', '/a2a/agents/a1/card'],
  ['front-door', 'POST', '/api/remote-access/enrolment'],
  ['front-door', 'POST', '/api/remote-access/mode'],
  ['front-door', 'POST', '/api/remote-access/withdraw'],
  ['front-door', 'POST', '/api/tunnel/start'],
  ['front-door', 'POST', '/api/lan-access'],
  ['front-door', 'POST', '/api/session-relay/link'],
  ['front-door', 'PATCH', '/api/session-relay/level'],
  ['front-door', 'DELETE', '/api/session-relay/link'],
  ['front-door', 'POST', '/api/runtimes/claude-code/credential'],
  ['front-door', 'POST', '/api/runtimes/codex/login'],
  ['front-door', 'POST', '/api/runtimes/opencode/openrouter/key'],
  ['front-door', 'POST', '/api/runtimes/opencode/provider/credential'],
  ['front-door', 'PUT', '/api/runtimes/doe/inference'],
  ['front-door', 'POST', '/api/marketplace/sources'],
  ['front-door', 'DELETE', '/api/marketplace/sources/community'],
  ['front-door', 'POST', '/api/extensions/trusted-sources'],
  ['front-door', 'DELETE', '/api/extensions/trusted-sources'],
  ['front-door', 'POST', '/api/auth/change-password'],
  ['front-door', 'POST', '/api/auth/set-password'],
  ['front-door', 'POST', '/api/auth/change-email'],
  ['host', 'POST', '/api/admin/reset/prepare'],
  ['host', 'POST', '/api/admin/reset'],
  ['host', 'POST', '/api/admin/restart'],
  ['host', 'POST', '/api/harness/sync'],
  ['host', 'POST', '/api/harness/adopt'],
  ['host', 'POST', '/api/workspaces'],
  ['host', 'POST', '/api/directory'],
  ['host', 'POST', '/api/agents/create'],
  ['host', 'POST', '/api/extensions/reload'],
  ['host', 'POST', '/api/extensions/x1/enable'],
  ['host', 'POST', '/api/extensions/x1/approve'],
  ['host', 'PUT', '/api/extensions/x1/secrets/token'],
  ['host', 'PUT', '/api/extensions/x1/settings/mode'],
  ['host', 'POST', '/api/marketplace/packages/p1/install'],
  ['host', 'POST', '/api/marketplace/packages/p1/uninstall'],
  ['host', 'POST', '/api/marketplace/updates'],
  ['host', 'POST', '/api/marketplace/dev-links'],
  ['host', 'POST', '/api/marketplace/held-back/p1/decision'],
  ['host', 'POST', '/api/shapes/s1/apply'],
  ['host', 'DELETE', '/api/workspaces/w1'],
  ['host', 'POST', '/api/agents'],
  ['host', 'POST', '/api/agents/current/migrate-persona'],
  ['host', 'POST', '/api/templates'],
  ['host', 'DELETE', '/api/templates/t1'],
  ['host', 'POST', '/api/mesh/agents'],
  ['host', 'DELETE', '/api/mesh/agents/a1/data'],
  ['host', 'PUT', '/api/mesh/topology/access'],
  ['front-door', 'POST', '/api/cloud/link/start'],
  ['front-door', 'POST', '/api/cloud/unlink'],
  ['front-door', 'POST', '/api/relay/adapters'],
  ['front-door', 'PATCH', '/api/relay/adapters/a1/config'],
  ['front-door', 'POST', '/api/relay/bindings'],
  ['front-door', 'POST', '/api/relay/unclaimed-chats/c1/claim'],
  ['front-door', 'POST', '/api/connectors/connections'],
  ['front-door', 'POST', '/api/connectors/executions'],
  ['front-door', 'POST', '/api/connectors/agent-requests/r1/decision'],
  ['file-writes', 'POST', '/api/rooms/r1/repo/merge'],
  ['file-writes', 'PUT', '/api/rooms/r1/canvas/d1/diff'],
  ['file-writes', 'POST', '/api/diff/revert'],
  ['api-keys', 'POST', '/api/config/mcp/reveal-token'],
  ['api-keys', 'POST', '/api/config/mcp/rotate-token'],
  ['front-door', 'PUT', '/api/connectors/providers/composio/credential'],
  ['host', 'POST', '/api/agents/agent-1/commitments'],
  ['sign-out-all', 'POST', '/api/devices/sign-out-all'],
  ['sign-out-all', 'POST', '/api/auth/revoke-sessions'],
  ['sign-out-all', 'POST', '/api/auth/revoke-other-sessions'],
  ['spending', 'PUT', '/api/community-connections/c_123/teammate-spend'],
];

/** What a Wi-Fi sign-in keeps: chat, reading, and approvals. */
const ALLOWED: readonly [string, string][] = [
  ['POST', '/api/sessions/s1/messages'],
  ['GET', '/api/sessions/s1/events'],
  ['GET', '/api/sessions'],
  ['POST', '/api/rooms/r1/messages'],
  ['POST', '/api/rooms/r1/attachments'],
  ['POST', '/api/uploads'],
  ['POST', '/api/approvals/a1/decide'],
  ['GET', '/api/files/content'],
  ['GET', '/api/files/tree'],
  ['GET', '/api/rooms/r1/files'],
  ['GET', '/api/rooms/r1/files/content'],
  ['GET', '/api/remote-access/report'],
  ['GET', '/api/tunnel/status'],
  ['GET', '/api/lan-access'],
  ['GET', '/api/community-connections/c_123/teammate-spend'],
  ['GET', '/api/session-relay/status'],
  ['GET', '/api/runtimes/opencode/provider'],
  ['GET', '/api/marketplace/sources'],
  ['GET', '/api/devices/sessions'],
  ['DELETE', '/api/devices/sessions/d1'],
  ['PATCH', '/api/config'],
  ['POST', '/api/auth/sign-out'],
  ['GET', '/api/auth/get-session'],
  ['POST', '/api/auth/sign-in/email'],
  ['GET', '/api/terminals-guide'],
  ['GET', '/api/filesystem'],
  ['POST', '/api/workspaces/ports'],
  ['POST', '/api/workspaces/w1/pin'],
  ['POST', '/api/mesh/agents/a1/heartbeat'],
  ['POST', '/api/relay/messages'],
  ['POST', '/api/connectors/holds/h1/cancel'],
  ['POST', '/api/cloud/link/cancel'],
  ['POST', '/api/agents/resolve'],
  ['POST', '/api/extensions/cwd-changed'],
  ['PUT', '/api/extensions/x1/data'],
  ['POST', '/api/marketplace/packages/p1/preview'],
  ['GET', '/api/extensions'],
  ['GET', '/api/harness/status'],
];

const WIFI = {
  headers: { host: '192.168.1.20:4243' },
  peerAddress: '192.168.1.31',
  ingress: 'wifi' as const,
};

/** A caller's facts, with any extra headers. */
function via(ingress: RequestIngress, headers: Record<string, string> = {}) {
  const host = ingress === 'wifi' ? WIFI.headers.host : 'localhost:4242';
  const peer = ingress === 'wifi' ? WIFI.peerAddress : '127.0.0.1';
  return { headers: { host, ...headers }, peerAddress: peer, ingress };
}

describe('the Wi-Fi level', () => {
  it('has a refused request for every route in the list, so the list cannot grow untested', () => {
    WIFI_REFUSED_ROUTES.forEach((route, index) => {
      const covered = REFUSED.some(
        ([, method, path]) => matchWifiRefusedRoute(method, [path], false) === route
      );
      expect(covered, `route ${index} (${route.surface}, ${route.pattern})`).toBe(true);
    });
  });

  it.each(REFUSED)('refuses %s: %s %s over Wi-Fi', (surface, method, path) => {
    const refusal = wifiLevelRefusal({ method, paths: [path], facts: via('wifi') });
    expect(refusal).toMatchObject({ status: 403, code: NOT_FROM_WIFI, surface });
    expect(refusal!.error).toMatch(/[.]$/);
  });

  it.each(REFUSED)('lets %s through from every other route: %s %s', (_surface, method, path) => {
    for (const ingress of ['direct', 'own-tunnel', 'managed', 'relay'] as const) {
      expect(wifiLevelRefusal({ method, paths: [path], facts: via(ingress) }), ingress).toBe(
        undefined
      );
    }
  });

  it.each(ALLOWED)('keeps %s %s for a Wi-Fi sign-in', (method, path) => {
    expect(wifiLevelRefusal({ method, paths: [path], facts: via('wifi') })).toBe(undefined);
  });

  it('refuses every spelling a lenient router might accept', () => {
    for (const path of [
      '/API/Terminal',
      '/api//terminal',
      '/api/terminal/',
      '/api/terminal?cwd=/tmp',
      '/api/auth/API-KEY/list',
    ]) {
      expect(
        wifiLevelRefusal({ method: 'POST', paths: [path], facts: via('wifi') }),
        path
      ).toMatchObject({
        code: NOT_FROM_WIFI,
      });
    }
  });

  it('refuses when any spelling of the path matches, the decoded one included', () => {
    const refusal = wifiLevelRefusal({
      method: 'POST',
      paths: ['/api/%74erminal', '/api/terminal'],
      facts: via('wifi'),
    });
    expect(refusal).toMatchObject({ surface: 'terminal' });
  });

  it('leaves /mcp and A2A to their own key, and refuses them by cookie alone', () => {
    for (const path of ['/mcp', '/a2a', '/a2a/agents/a1']) {
      const bearer = via('wifi', { authorization: 'Bearer key' });
      expect(wifiLevelRefusal({ method: 'POST', paths: [path], facts: bearer })).toBe(undefined);
      // A bearer riding beside a session cookie is no key-only request.
      const both = via('wifi', {
        authorization: 'Bearer x',
        cookie: 'better-auth.session_token=x',
      });
      expect(wifiLevelRefusal({ method: 'POST', paths: [path], facts: both })).toMatchObject({
        code: NOT_FROM_WIFI,
      });
      const cookie = via('wifi', { cookie: 'better-auth.session_token=x' });
      expect(wifiLevelRefusal({ method: 'POST', paths: [path], facts: cookie })).toMatchObject({
        code: NOT_FROM_WIFI,
      });
    }
  });

  it('holds an API key on the Wi-Fi listener to the same level everywhere else', () => {
    const key = via('wifi', { authorization: 'Bearer key' });
    expect(
      wifiLevelRefusal({ method: 'POST', paths: ['/api/terminal'], facts: key })
    ).toMatchObject({
      code: NOT_FROM_WIFI,
    });
  });

  it('never refuses a read of a write-only rule', () => {
    for (const route of WIFI_REFUSED_ROUTES.filter((r) => r.methods === 'writes')) {
      const sample = REFUSED.find(([, m, p]) => matchWifiRefusedRoute(m, [p], false) === route)!;
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        expect(matchWifiRefusedRoute(method, [sample[2]], false)).not.toBe(route);
      }
    }
  });

  it('writes every reason as one short plain sentence', () => {
    for (const route of WIFI_REFUSED_ROUTES) {
      expect(route.reason).toMatch(/^[A-Z].*\.$/);
      expect(route.reason.split(/\s+/).length).toBeLessThanOrEqual(15);
      expect(route.reason).not.toMatch(/\bwe\b/i);
    }
  });
});
