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
  getAuth: () => null,
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
import { gateAccessFor, isAtThisComputer, type GateAccess } from '../gate-policy.js';
import { decideMcpAuth } from '../../../../middleware/mcp-auth.js';
import { authorizeStreamUpgrade } from '../../streams/stream-upgrade-auth.js';
import { markIngress, type IngressKind } from '../../remote/ingress-mark.js';
import type { RequestFacts } from '../../../../http/request-facts.js';

type Facts = Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress'>;

/** One caller kind: how its requests look, and what it needs in each posture. */
interface CallerKind {
  name: string;
  facts: Facts;
  /** Under `DORKOS_ALLOW_INSECURE_BIND`, as the container image runs. */
  insecureBind?: boolean;
  expected: (cell: { ask: boolean; exposure: boolean }) => GateAccess;
}

const LOCAL_HEADERS = { host: 'localhost:4242' };

const CALLERS: CallerKind[] = [
  {
    name: 'local (this computer)',
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'direct' },
    expected: ({ ask }) => (ask ? 'credential' : 'open'),
  },
  {
    name: 'Wi-Fi',
    facts: { headers: { host: '192.168.1.20:4243' }, peerAddress: '192.168.1.31', ingress: 'wifi' },
    expected: () => 'credential',
  },
  {
    name: 'own tunnel',
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'own-tunnel' },
    expected: () => 'credential',
  },
  {
    name: 'managed remote',
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'managed' },
    expected: () => 'credential',
  },
  {
    name: 'relayed',
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'relay' },
    expected: () => 'refused',
  },
  {
    // A browser reaching a container through its published port. With no owner
    // yet it keeps today's open posture for one release (rule 11, F5 ends it).
    name: 'insecure bind (container)',
    facts: { headers: { host: '192.168.1.5:4242' }, peerAddress: '172.17.0.1', ingress: 'direct' },
    insecureBind: true,
    expected: ({ exposure }) => (exposure ? 'credential' : 'open'),
  },
  {
    name: 'same-host proxy with forwarding headers',
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
    facts: { headers: LOCAL_HEADERS, peerAddress: '127.0.0.1', ingress: 'direct' },
    expected: ({ ask }) => (ask ? 'credential' : 'open'),
  },
  {
    // A write through the same proxy names its public page, which catches it.
    name: 'same-host proxy without forwarding headers (write with Origin)',
    facts: {
      headers: { ...LOCAL_HEADERS, origin: 'https://dorkos.example.com' },
      peerAddress: '127.0.0.1',
      ingress: 'direct',
    },
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
    const atThisComputer =
      caller.name.startsWith('local') ||
      caller.name.includes('(GET, no Origin)') ||
      caller.name.startsWith('insecure bind');
    expect(isAtThisComputer(caller.facts)).toBe(atThisComputer);
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
});
