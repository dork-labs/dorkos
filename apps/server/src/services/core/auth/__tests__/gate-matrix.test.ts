/**
 * The F1 acceptance matrix (DOR-2967, ADR 261015-125850 rules 1 to 3): every
 * gated surface, against every caller kind, with "Ask for a password on this
 * computer too" on and off, and exposure on and off.
 *
 * Exposure on means an owner account exists (exposure needs one); exposure off
 * means none does. No cell presents a credential, so a cell that needs one is
 * refused on every surface: what each cell shows is whether the surface lets
 * the caller in with nothing, which is the whole question the global switch
 * used to answer for everyone at once.
 *
 * The terminal socket has no row of its own: it is bearer-of-id (ADR
 * 260708-185521), and the id comes only from `POST /api/terminal`, which is the
 * `/api` row. Rooms, community and session streams over a socket are the
 * `stream socket` row; over SSE they are the `SSE` row.
 */
import type { IncomingMessage } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const posture = vi.hoisted(() => ({ ask: false, owner: false, insecureBind: false }));

vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: posture.ask } : undefined),
  },
}));
vi.mock('../index.js', () => ({
  // The owner has one session per route: the cookie `session=owner@<route>`
  // is the one made on that route, and `session=owner@legacy` one made before
  // routes were recorded. Everything else verifies as nobody, so a cell admits
  // a credential only when it presents one of those.
  getAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const made = /^session=owner@(\w+)$/.exec(headers.get('cookie') ?? '')?.[1];
        if (!made) return null;
        const route = made === 'legacy' ? null : made;
        return {
          user: { id: 'owner' },
          session: { id: `session-${made}`, route, createdAt: new Date() },
        };
      },
      verifyApiKey: async () => ({ valid: false }),
    },
  }),
  hasAnyUser: () => posture.owner,
  verifyRequestAuth: async () => null,
}));
vi.mock('../../../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../env.js')>();
  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'DORKOS_ALLOW_INSECURE_BIND'
          ? posture.insecureBind
          : key === 'MCP_API_KEY'
            ? undefined
            : Reflect.get(target, key),
    }),
  };
});
vi.mock('../mcp-local-token.js', () => ({
  getMcpLocalToken: () => 'local-token',
  getMcpLocalTokenPath: () => '/tmp/mcp-local-token',
}));
vi.mock('../../../../middleware/agent-identity.js', () => ({
  resolveAgentIdentityFromHeaders: async () => undefined,
}));

import { decideSessionGate } from '../session-gate.js';
import {
  gateAccessFor,
  isAtThisComputer,
  isContainerPortClass,
  type GateAccess,
} from '../gate-policy.js';
import { classifyRequest } from '../../../../lib/request-classifier.js';
import { requestSessionRoute, SESSION_ROUTES } from '../sessions/session-route.js';
import { decideMcpAuth } from '../../../../middleware/mcp-auth.js';
import { authorizeStreamUpgrade } from '../../streams/stream-upgrade-auth.js';
import { markIngress, type IngressKind } from '../../remote/ingress-mark.js';
import { NOT_FROM_WIFI, refuseUpgradeFromWifi, wifiLevelRefusal } from '../sessions/wifi-level.js';
import type { RequestFacts } from '../../../../http/request-facts.js';

type Facts = Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress'>;

/** One caller kind: how its requests look, and what it needs in each posture. */
interface CallerKind {
  name: string;
  facts: Facts;
  /** Under `DORKOS_ALLOW_INSECURE_BIND`, as the container image runs. */
  insecureBind?: boolean;
  expected: (cell: { ask: boolean; exposure: boolean }) => GateAccess;
  /** Whether it counts as a person at this computer, with no owner and no session. */
  atThisComputer: boolean;
}

const LOCAL_HEADERS = { host: 'localhost:4242' };

const CALLERS: CallerKind[] = [
  {
    name: 'local (this computer)',
    atThisComputer: true,
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'direct' },
    expected: ({ ask }) => (ask ? 'credential' : 'open'),
  },
  {
    name: 'Wi-Fi',
    atThisComputer: false,
    facts: { headers: { host: '192.168.1.20:4243' }, peerAddress: '192.168.1.31', ingress: 'wifi' },
    expected: () => 'credential',
  },
  {
    name: 'own tunnel',
    atThisComputer: false,
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'own-tunnel' },
    expected: () => 'credential',
  },
  {
    name: 'managed remote',
    atThisComputer: false,
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'managed' },
    expected: () => 'credential',
  },
  {
    name: 'relayed',
    atThisComputer: false,
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'relay' },
    expected: () => 'refused',
  },
  {
    // A browser reaching a container through its published port. With no owner
    // yet it keeps today's open posture for one release (rule 11, F5 ends it).
    name: 'insecure bind (container)',
    atThisComputer: true,
    facts: { headers: { host: '192.168.1.5:4242' }, peerAddress: '172.17.0.1', ingress: 'direct' },
    insecureBind: true,
    expected: ({ exposure }) => (exposure ? 'credential' : 'open'),
  },
  {
    name: 'same-host proxy with forwarding headers',
    atThisComputer: false,
    facts: {
      headers: { ...LOCAL_HEADERS, 'x-forwarded-for': '203.0.113.9' },
      peerAddress: '127.0.0.1',
      ingress: 'direct',
    },
    expected: () => 'credential',
  },
  {
    // The named residual: indistinguishable from this computer for a
    // same-origin GET with neither Origin nor Referer.
    name: 'same-host proxy without forwarding headers (GET, no Origin)',
    atThisComputer: true,
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'direct' },
    expected: ({ ask }) => (ask ? 'credential' : 'open'),
  },
  {
    // A write through the same proxy names its public page, which catches it.
    name: 'same-host proxy without forwarding headers (write with Origin)',
    atThisComputer: false,
    facts: {
      headers: { ...LOCAL_HEADERS, origin: 'https://dorkos.example.com' },
      peerAddress: '127.0.0.1',
      ingress: 'direct',
    },
    expected: () => 'credential',
  },
  {
    // The container flag never opens a proxy in front of it: its forwarding
    // headers make it another device first.
    name: 'insecure bind behind a proxy with forwarding headers',
    atThisComputer: false,
    facts: {
      headers: { host: '192.168.1.5:4242', 'x-forwarded-for': '203.0.113.9' },
      peerAddress: '172.17.0.1',
      ingress: 'direct',
    },
    insecureBind: true,
    expected: () => 'credential',
  },
  {
    // Nor a page that rebound a name onto this computer's address.
    name: 'insecure bind, DNS rebinding Host',
    atThisComputer: false,
    facts: { headers: { host: 'evil.example:4242' }, peerAddress: '127.0.0.1', ingress: 'direct' },
    insecureBind: true,
    expected: () => 'credential',
  },
];

const CELLS = CALLERS.flatMap((caller) =>
  [false, true].flatMap((ask) => [false, true].map((exposure) => ({ caller, ask, exposure })))
);

/** An upgrade request carrying the caller's facts, marked as its listener would mark it. */
function upgradeRequest(facts: Facts): IncomingMessage {
  const req = { headers: facts.headers, socket: { remoteAddress: facts.peerAddress } };
  if (facts.ingress !== 'direct') {
    markIngress(req as IncomingMessage, facts.ingress as IngressKind);
  }
  return req as IncomingMessage;
}

/** Whether a surface let the caller in with nothing. */
interface SurfaceAnswers {
  api: boolean;
  sse: boolean;
  mcpLocalTokenWrite: boolean;
  mcpTokenlessHandshake: boolean;
  a2aCardTokenless: boolean;
  streamSocket: boolean;
}

async function askEverySurface(facts: Facts): Promise<SurfaceAnswers> {
  const mcpBase = {
    headers: facts.headers,
    peerAddress: facts.peerAddress,
    ingress: facts.ingress,
  };
  return {
    api: (await decideSessionGate('POST', '/api/sessions', facts)).allowed,
    sse: (await decideSessionGate('GET', '/api/sessions/s1/events', facts)).allowed,
    mcpLocalTokenWrite: (
      await decideMcpAuth('mcp', {
        ...mcpBase,
        headers: { ...facts.headers, authorization: 'Bearer local-token' },
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_agent' } },
      })
    ).allowed,
    mcpTokenlessHandshake: (
      await decideMcpAuth('mcp', {
        ...mcpBase,
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      })
    ).allowed,
    a2aCardTokenless: (await decideMcpAuth('a2a', { ...mcpBase, method: 'GET', body: undefined }))
      .allowed,
    streamSocket: (await authorizeStreamUpgrade(upgradeRequest(facts))).ok,
  };
}

describe('the gate matrix: every surface × every caller kind × ask × exposure', () => {
  beforeEach(() => {
    posture.ask = false;
    posture.owner = false;
    posture.insecureBind = false;
  });

  it.each(
    CELLS.map((cell) => [
      `${cell.caller.name}, ask ${cell.ask ? 'on' : 'off'}, exposure ${cell.exposure ? 'on' : 'off'}`,
      cell,
    ])
  )('%s', async (_label, { caller, ask, exposure }) => {
    posture.ask = ask;
    posture.owner = exposure;
    posture.insecureBind = caller.insecureBind === true;

    const expected = caller.expected({ ask, exposure });
    expect(gateAccessFor(caller.facts)).toBe(expected);

    const open = expected === 'open';
    expect(await askEverySurface(caller.facts)).toEqual({
      api: open,
      sse: open,
      mcpLocalTokenWrite: open,
      mcpTokenlessHandshake: open,
      a2aCardTokenless: open,
      streamSocket: open,
    });
  });
});

describe('who counts as at this computer', () => {
  beforeEach(() => {
    posture.ask = false;
    posture.owner = false;
    posture.insecureBind = false;
  });

  it.each(CALLERS.map((caller) => [caller.name, caller]))('%s', (_label, caller) => {
    posture.insecureBind = caller.insecureBind === true;
    expect(isAtThisComputer(caller.facts)).toBe(caller.atThisComputer);
  });

  it('never counts a tunnel, Wi-Fi, managed or relayed request, even under the container flag', () => {
    posture.insecureBind = true;
    for (const ingress of ['wifi', 'own-tunnel', 'managed', 'relay'] as const) {
      expect(
        isAtThisComputer({ headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress }),
        ingress
      ).toBe(false);
    }
  });

  it('counts the CLI inside a container with an owner as this computer', () => {
    posture.insecureBind = true;
    posture.owner = true;
    const cli: Facts = { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'direct' };
    expect(isAtThisComputer(cli)).toBe(true);
    expect(gateAccessFor(cli)).toBe('open');
  });

  it('once a container has an owner, counts a browser session at its port, never an API key', () => {
    posture.insecureBind = true;
    posture.owner = true;
    const port: Facts = {
      headers: { host: '192.168.1.5:4242' },
      peerAddress: '172.17.0.1',
      ingress: 'direct',
    };
    expect(isAtThisComputer({ ...port, user: { userId: 'owner', credential: 'cookie' } })).toBe(
      true
    );
    expect(isAtThisComputer({ ...port, user: { userId: 'owner', credential: 'api-key' } })).toBe(
      false
    );
    expect(isAtThisComputer(port)).toBe(false);
  });
});

/** Every route a session can be made on, and a session from before routes were recorded. */
const MADE_ON = [...SESSION_ROUTES, 'legacy'] as const;

/** A caller's facts carrying the owner session made on `made`. */
function withSession(facts: Facts, made: (typeof MADE_ON)[number]): Facts {
  return { ...facts, headers: { ...facts.headers, cookie: `session=owner@${made}` } };
}

describe('a credential lets another device in, only on its own route', () => {
  beforeEach(() => {
    posture.ask = false;
    posture.owner = true;
    posture.insecureBind = false;
  });

  const credentialed = CALLERS.filter(
    (caller) => caller.expected({ ask: false, exposure: true }) === 'credential'
  ).map((caller) => [caller.name, caller] as const);

  it.each(credentialed)('%s, with the session made on its route', async (_label, caller) => {
    posture.insecureBind = caller.insecureBind === true;
    const route = requestSessionRoute(caller.facts)!;
    const facts = withSession(caller.facts, route);
    expect(await decideSessionGate('POST', '/api/sessions', facts)).toEqual({
      allowed: true,
      user: { userId: 'owner', credential: 'cookie', sessionId: `session-${route}`, route },
    });
    expect(await authorizeStreamUpgrade(upgradeRequest(facts))).toMatchObject({ ok: true });
  });

  it.each(credentialed)(
    '%s, with a session made anywhere else, is refused',
    async (_label, caller) => {
      posture.insecureBind = caller.insecureBind === true;
      const route = requestSessionRoute(caller.facts);
      for (const made of MADE_ON.filter((other) => other !== route)) {
        const facts = withSession(caller.facts, made);
        expect(await decideSessionGate('POST', '/api/sessions', facts)).toEqual({
          allowed: false,
        });
        expect(await decideSessionGate('GET', '/api/sessions', facts)).toEqual({
          allowed: false,
        });
        expect(await authorizeStreamUpgrade(upgradeRequest(facts))).toMatchObject({
          ok: false,
          status: 401,
        });
      }
    }
  );

  it('at this computer, asking for a password, takes a local or older session only', async () => {
    posture.ask = true;
    const local = CALLERS.find((caller) => caller.name === 'local (this computer)')!.facts;
    for (const made of MADE_ON) {
      const decision = await decideSessionGate('POST', '/api/sessions', withSession(local, made));
      expect(decision.allowed).toBe(made === 'local' || made === 'legacy');
    }
  });
});

describe('the container exception, as the sign-up hook asks it', () => {
  beforeEach(() => {
    posture.insecureBind = true;
  });

  it.each(CALLERS.map((caller) => [caller.name, caller]))('%s', (_label, caller) => {
    const expected = caller.name === 'insecure bind (container)';
    expect(isContainerPortClass(classifyRequest(caller.facts, 'computer'))).toBe(expected);
  });

  it('is never true without the container flag', () => {
    posture.insecureBind = false;
    const port = CALLERS.find((caller) => caller.name === 'insecure bind (container)')!;
    expect(isContainerPortClass(classifyRequest(port.facts, 'computer'))).toBe(false);
  });
});

/**
 * The Wi-Fi rows (F4 part 3, DOR-2969): one request per refused surface, for
 * every caller kind. Only the Wi-Fi caller is refused, and only by the Wi-Fi
 * level; every other caller's answer is the gate's, unchanged above.
 */
const WIFI_REFUSED_SURFACES: readonly [string, string, string][] = [
  ['terminal (HTTP)', 'POST', '/api/terminal'],
  ['file write', 'PUT', '/api/files/content'],
  ['API key', 'POST', '/api/auth/api-key/create'],
  ['/mcp by cookie', 'POST', '/mcp'],
  ['A2A by cookie', 'POST', '/a2a'],
  ['front-door setting', 'POST', '/api/lan-access'],
  ['admin reset', 'POST', '/api/admin/reset'],
  ['sign-out-all', 'POST', '/api/devices/sign-out-all'],
];

describe('the Wi-Fi level: every refused surface × every caller kind', () => {
  beforeEach(() => {
    posture.ask = false;
    posture.owner = true;
    posture.insecureBind = false;
  });

  const rows = CALLERS.flatMap((caller) =>
    WIFI_REFUSED_SURFACES.map(
      ([surface, method, path]) => [`${caller.name}, ${surface}`, caller, method, path] as const
    )
  );

  it.each(rows)('%s', (_label, caller, method, path) => {
    posture.insecureBind = caller.insecureBind === true;
    const refusal = wifiLevelRefusal({ method, paths: [path], facts: caller.facts });
    if (caller.name === 'Wi-Fi')
      expect(refusal).toMatchObject({ status: 403, code: NOT_FROM_WIFI });
    else expect(refusal).toBe(undefined);
  });

  it.each(CALLERS.map((caller) => [caller.name, caller]))(
    "the terminal's socket, %s",
    (_label, caller) => {
      posture.insecureBind = caller.insecureBind === true;
      const req = upgradeRequest(caller.facts) as IncomingMessage & { url: string };
      req.url = '/api/terminal/t1/socket';
      const refusal = refuseUpgradeFromWifi(req, '/api/terminal/t1/socket');
      expect(refusal !== undefined).toBe(caller.name === 'Wi-Fi');
    }
  );

  it('keeps chat and its streams for a Wi-Fi sign-in', () => {
    const wifi = CALLERS.find((caller) => caller.name === 'Wi-Fi')!.facts;
    for (const [method, path] of [
      ['POST', '/api/sessions/s1/messages'],
      ['GET', '/api/sessions/s1/events'],
      ['POST', '/api/approvals/a1/decide'],
    ] as const) {
      expect(wifiLevelRefusal({ method, paths: [path], facts: wifi })).toBe(undefined);
    }
  });
});
