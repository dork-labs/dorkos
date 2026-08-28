/**
 * The one decision every runtime shares: whether to hand a Codex or OpenCode
 * session the `dorkos` MCP server, and what to put in its headers
 * (spec `tool-only-room-replies` §D4, DOR-1613).
 *
 * Two things are load-bearing here and are asserted rather than reasoned about.
 *
 * **The URL never contains `127.0.0.1`** (DOR-723). The server binds
 * `env.DORKOS_HOST`, which Node resolves to ONE address family; on a host where
 * that is `::1`, a `127.0.0.1` URL is connection-refused, and the shipped Docker
 * image binds the wildcard `0.0.0.0`, which Windows will not dial at all. The
 * IPv6 case is covered explicitly because it is the one that produces an
 * UNPARSEABLE url rather than merely a wrong one: `new URL('http://::1:4242')`
 * throws, so the literal has to be bracketed.
 *
 * **A half-credentialed entry is never emitted.** Without `Authorization` every
 * room write is a 401; without `X-DorkOS-Agent` the agent posts in the INSTALL
 * OWNER's name, which is impersonation rather than a degraded experience. So
 * each missing precondition is checked for `null` — injecting nothing — and not
 * merely for an absent header.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../core/agent-identity/index.js';

/** The `env` the module under test reads, rewritten per case. */
const envState = vi.hoisted(() => ({
  DORKOS_HOST: 'localhost',
  DORKOS_PORT: 4242,
  MCP_API_KEY: undefined as string | undefined,
}));

vi.mock('../../../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../env.js')>();
  return { ...actual, env: envState };
});

/** The config the module reads, rewritten per case. */
const configState = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('../../../core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config-manager.js')>();
  return {
    ...actual,
    configManager: {
      get: (key: string) => configState.value[key],
      getAll: () => configState.value,
    },
  };
});

const tokenMocks = vi.hoisted(() => ({ local: null as string | null }));

vi.mock('../../../core/auth/mcp-local-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/auth/mcp-local-token.js')>();
  return { ...actual, getMcpLocalToken: () => tokenMocks.local };
});

const {
  dorkosMcpUrl,
  resolveDorkosMcpInjection,
  DORKOS_MCP_SERVER_NAME,
  DORKOS_MCP_HEADER_ENV_VARS,
} = await import('../dorkos-mcp-injection.js');

/** Config with the experiment on and `/mcp` mounted — the working baseline. */
function wiredConfig(): Record<string, unknown> {
  return { runtimes: { dorkosTools: true }, mcp: { enabled: true } };
}

describe('the dorkos MCP entry DorkOS injects into codex and opencode', () => {
  let agentDir: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(tmpdir(), 'dorkos-mcp-injection-'));
    db = createTestDb();
    initAgentIdentityService(db);
    envState.DORKOS_HOST = 'localhost';
    envState.DORKOS_PORT = 4242;
    envState.MCP_API_KEY = undefined;
    tokenMocks.local = 'dork_mcp_local_abc123';
    configState.value = wiredConfig();
  });

  afterEach(async () => {
    resetAgentIdentityService();
    await rm(agentDir, { recursive: true, force: true });
  });

  describe('the URL it dials (DOR-723)', () => {
    it('uses the bind host, and never a hardcoded 127.0.0.1', () => {
      envState.DORKOS_HOST = 'localhost';
      expect(dorkosMcpUrl()).toBe('http://localhost:4242/mcp');
      expect(dorkosMcpUrl()).not.toContain('127.0.0.1');
    });

    it('maps a wildcard bind to localhost, because a wildcard is not dialable', () => {
      // The shipped Docker image sets `DORKOS_HOST=0.0.0.0`, and Windows refuses
      // to connect to it outright — so this is the container case, not a corner.
      envState.DORKOS_HOST = '0.0.0.0';
      expect(dorkosMcpUrl()).toBe('http://localhost:4242/mcp');
      envState.DORKOS_HOST = '::';
      expect(dorkosMcpUrl()).toBe('http://localhost:4242/mcp');
    });

    it('brackets an IPv6 literal, so the URL is parseable at all', () => {
      // The sharp one: an unbracketed `::1` does not make a WRONG url, it makes
      // an unparseable one. Asserted by parsing it, not by string comparison,
      // because string comparison would pass on a URL no client can use.
      envState.DORKOS_HOST = '::1';
      const url = dorkosMcpUrl();
      expect(url).toBe('http://[::1]:4242/mcp');
      expect(() => new URL(url)).not.toThrow();
      expect(new URL(url).hostname).toBe('[::1]');
      // And the unbracketed form really is unparseable, so the case above is
      // testing something rather than restating a preference.
      expect(() => new URL('http://::1:4242/mcp')).toThrow();
    });

    it('honours a non-default port', () => {
      envState.DORKOS_PORT = 6242;
      expect(dorkosMcpUrl()).toBe('http://localhost:6242/mcp');
    });
  });

  describe('when it injects, and what it presents', () => {
    it('emits the URL and BOTH headers for a wired agent session', async () => {
      const injection = await resolveDorkosMcpInjection(agentDir, 'Researcher');
      expect(injection).not.toBeNull();
      expect(injection?.url).toBe('http://localhost:4242/mcp');
      expect(injection?.headers['Authorization']).toBe('Bearer dork_mcp_local_abc123');
      expect(injection?.headers['x-dorkos-agent']).toEqual(expect.any(String));
      expect(injection?.headers['x-dorkos-agent']).not.toBe('');
    });

    it('prefers MCP_API_KEY, which is the bearer whenever it is set', async () => {
      // `getMcpLocalToken` returns null whenever `MCP_API_KEY` is set, so these
      // are mutually exclusive in production. Both are supplied here so the
      // assertion is about the ORDER rather than about which one happened to
      // exist.
      envState.MCP_API_KEY = 'env-key-9';
      const injection = await resolveDorkosMcpInjection(agentDir, 'Researcher');
      expect(injection?.headers['Authorization']).toBe('Bearer env-key-9');
    });

    it('mints a FRESH identity token every time, so no fuse can arm', async () => {
      // Tokens expire on a 7-day-idle / 30-day-absolute fuse, and a stored hash
      // cannot be reversed to reissue an existing secret — so a cached entry on
      // a long-lived agent would eventually 401 on every room write. Two
      // resolves must not produce the same credential.
      const first = await resolveDorkosMcpInjection(agentDir, 'Researcher');
      const second = await resolveDorkosMcpInjection(agentDir, 'Researcher');
      expect(first?.headers['x-dorkos-agent']).toBeDefined();
      expect(second?.headers['x-dorkos-agent']).toBeDefined();
      expect(second?.headers['x-dorkos-agent']).not.toBe(first?.headers['x-dorkos-agent']);
    });

    it('registers under the name both runtimes reserve', () => {
      expect(DORKOS_MCP_SERVER_NAME).toBe('dorkos');
    });
  });

  describe('when it withholds', () => {
    it('injects nothing while the experiment is off — the default', async () => {
      configState.value = { runtimes: { dorkosTools: false }, mcp: { enabled: true } };
      expect(await resolveDorkosMcpInjection(agentDir, 'Researcher')).toBeNull();
    });

    it('injects nothing for a directory that hosts no registered agent', async () => {
      // These tools act as SOMEBODY. With no agent there is no identity to
      // present, and presenting none means posting as the install owner.
      expect(await resolveDorkosMcpInjection(undefined, undefined)).toBeNull();
    });

    it('injects nothing when the MCP endpoint is switched off', async () => {
      // `/mcp` answers a clean 503 behind `requireMcpEnabled`, so the entry
      // would be a server that never connects.
      configState.value = { runtimes: { dorkosTools: true }, mcp: { enabled: false } };
      expect(await resolveDorkosMcpInjection(agentDir, 'Researcher')).toBeNull();
    });

    it('injects nothing when there is no bearer to present', async () => {
      // Reachable: login ON with no `MCP_API_KEY`. The local token is inactive
      // in that posture (ADR-0320), and there is no tokenless path on this
      // surface — not even tool discovery — so every call would 401.
      tokenMocks.local = null;
      envState.MCP_API_KEY = undefined;
      expect(await resolveDorkosMcpInjection(agentDir, 'Researcher')).toBeNull();
    });

    it('injects nothing when the identity service cannot mint', async () => {
      // The security case: an entry without `X-DorkOS-Agent` would post in the
      // operator's name. Withholding the whole server is the only safe answer.
      resetAgentIdentityService();
      expect(await resolveDorkosMcpInjection(agentDir, 'Researcher')).toBeNull();
    });

    it('never emits a partial header set — on the withholding paths OR the injecting one', async () => {
      // The invariant behind all five: there is no state in which one header
      // ships without the other.
      //
      // The wired config is FIRST and is asserted to actually inject, because
      // without it this loop is vacuous: every other case returns null, the
      // `if` never runs, and the whole thing passes with a header deleted from
      // the implementation. That was measured, not imagined.
      const cases = [
        { config: wiredConfig(), injects: true },
        { config: { runtimes: { dorkosTools: true }, mcp: { enabled: false } }, injects: false },
        { config: { runtimes: { dorkosTools: false }, mcp: { enabled: true } }, injects: false },
        { config: {}, injects: false },
      ];
      let asserted = 0;
      for (const { config, injects } of cases) {
        configState.value = config;
        const injection = await resolveDorkosMcpInjection(agentDir, 'Researcher');
        expect(injection !== null, JSON.stringify(config)).toBe(injects);
        if (injection !== null) {
          expect(Object.keys(injection.headers).sort()).toEqual([
            'Authorization',
            'x-dorkos-agent',
          ]);
          asserted += 1;
        }
      }
      // The guard on the guard: at least one case reached the assertion.
      expect(asserted).toBe(1);
    });

    it('has an environment variable defined for every header it emits', async () => {
      // Codex cannot pass a header value through `config` — that becomes visible
      // argv — so it redirects each one through an env var named in
      // `DORKOS_MCP_HEADER_ENV_VARS`. A header added here without a variable
      // there would have no safe way to travel, and `dorkosHeaderEnvNames`
      // throws on it. This is the cheaper place to notice.
      const injection = await resolveDorkosMcpInjection(agentDir, 'Researcher');
      expect(injection).not.toBeNull();
      for (const header of Object.keys(injection?.headers ?? {})) {
        expect(DORKOS_MCP_HEADER_ENV_VARS[header], `no env var for the ${header} header`).toEqual(
          expect.any(String)
        );
      }
    });
  });
});
