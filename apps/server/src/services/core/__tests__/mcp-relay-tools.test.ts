/**
 * The relay tools an agent still has after the send, inbox and endpoint tools
 * retired (spec `spin-off-chats` §7): endpoint listing, and the sender identity
 * `relay_notify_user` resolves its bindings from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createRelayListEndpointsHandler,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import { getRelayTools } from '../../runtimes/claude-code/mcp-tools/relay-tools.js';
import {
  resolveSenderIdentity,
  EXTERNAL_MCP_SENDER,
  type SenderIdentity,
} from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

/** Server-injected identity used in place of the removed self-declared `from`. */
const SENDER: SenderIdentity = { subject: 'relay.agent.sender', agentId: 'sender' };

function makeMockDeps(relayOverrides?: Record<string, unknown>): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    relayCore:
      relayOverrides === undefined
        ? undefined
        : ({
            listEndpoints: vi.fn().mockReturnValue([
              {
                subject: 'relay.agent.a',
                hash: 'h1',
                maildirPath: '/tmp/a',
                registeredAt: new Date().toISOString(),
              },
            ]),
            getDispatchInboxTtlMs: vi.fn().mockReturnValue(30 * 60 * 1000),
            ...relayOverrides,
          } as unknown as McpToolDeps['relayCore']),
  };
}

describe('relay_list_endpoints', () => {
  it('returns RELAY_DISABLED when relayCore is undefined', async () => {
    const handler = createRelayListEndpointsHandler(makeMockDeps());
    const result = await handler();
    expect(result.isError).toBe(true);
  });

  it('lists endpoints', async () => {
    const deps = makeMockDeps({});
    const handler = createRelayListEndpointsHandler(deps);
    const result = await handler();
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.endpoints[0].subject).toBe('relay.agent.a');
  });
});

describe('relay_list_endpoints with type metadata', () => {
  it('returns correct type for dispatch, query, persistent, and agent endpoints', async () => {
    // Purpose: verify inferEndpointType is applied to each endpoint in response.
    const mockEndpoints = [
      {
        subject: 'relay.inbox.dispatch.abc',
        hash: 'h1',
        maildirPath: '/tmp/a',
        registeredAt: new Date().toISOString(),
      },
      {
        subject: 'relay.inbox.query.def',
        hash: 'h2',
        maildirPath: '/tmp/b',
        registeredAt: new Date().toISOString(),
      },
      {
        subject: 'relay.inbox.myagent',
        hash: 'h3',
        maildirPath: '/tmp/c',
        registeredAt: new Date().toISOString(),
      },
      {
        subject: 'relay.agent.lifeOS',
        hash: 'h4',
        maildirPath: '/tmp/d',
        registeredAt: new Date().toISOString(),
      },
      {
        subject: 'relay.human.console.x',
        hash: 'h5',
        maildirPath: '/tmp/e',
        registeredAt: new Date().toISOString(),
      },
    ];
    const mockRelay = {
      listEndpoints: vi.fn().mockReturnValue(mockEndpoints),
      getDispatchInboxTtlMs: vi.fn().mockReturnValue(30 * 60 * 1000),
    };
    const handler = createRelayListEndpointsHandler({
      relayCore: mockRelay as never,
    } as McpToolDeps);
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);
    const bySubject = Object.fromEntries(
      parsed.endpoints.map((e: { subject: string; type: string }) => [e.subject, e.type])
    );
    expect(bySubject['relay.inbox.dispatch.abc']).toBe('dispatch');
    expect(bySubject['relay.inbox.query.def']).toBe('query');
    expect(bySubject['relay.inbox.myagent']).toBe('persistent');
    expect(bySubject['relay.agent.lifeOS']).toBe('agent');
    expect(bySubject['relay.human.console.x']).toBe('unknown');
  });

  it('returns expiresAt ISO string for dispatch endpoints and null for others', async () => {
    // Purpose: verify TTL transparency field computation.
    const registeredAt = new Date('2026-03-05T10:00:00.000Z').toISOString();
    const ttlMs = 30 * 60 * 1000;
    const mockEndpoints = [
      { subject: 'relay.inbox.dispatch.abc', hash: 'h1', maildirPath: '/tmp/a', registeredAt },
      { subject: 'relay.inbox.query.def', hash: 'h2', maildirPath: '/tmp/b', registeredAt },
    ];
    const mockRelay = {
      listEndpoints: vi.fn().mockReturnValue(mockEndpoints),
      getDispatchInboxTtlMs: vi.fn().mockReturnValue(ttlMs),
    };
    const handler = createRelayListEndpointsHandler({
      relayCore: mockRelay as never,
    } as McpToolDeps);
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);
    const dispatch = parsed.endpoints.find(
      (e: { subject: string }) => e.subject === 'relay.inbox.dispatch.abc'
    );
    const query = parsed.endpoints.find(
      (e: { subject: string }) => e.subject === 'relay.inbox.query.def'
    );
    // Dispatch: expiresAt = registeredAt + 30min
    expect(dispatch.expiresAt).toBe(
      new Date(new Date(registeredAt).getTime() + ttlMs).toISOString()
    );
    expect(query.expiresAt).toBeNull();
  });
});

describe('resolveSenderIdentity', () => {
  // The registry-backed behavior (nested layouts, explicit-namespace
  // manifests, and the invariant `resolveSenderIdentity(cwd).subject ===
  // inspect(agentId).relaySubject`) is proven against a REAL MeshCore +
  // RelayCore in packages/mesh/src/__tests__/identity-access.integration.test.ts.
  // These unit tests pin the delegation contract: identity comes from
  // `getSubjectByPath()` (the un-stripped registry entry). `getByPath()` must
  // NOT be consulted — its public manifest has `namespace` stripped, which
  // would silently degrade the subject to basename(cwd) and match no rule.
  it('delegates to meshCore.getSubjectByPath, never the namespace-stripped getByPath', () => {
    const getSubjectByPath = vi
      .fn()
      .mockReturnValue({ subject: 'relay.agent.team.a1', agentId: 'a1' });
    // Mirrors the real getByPath contract: public manifest, namespace stripped.
    const getByPath = vi.fn().mockReturnValue({ id: 'a1', name: 'my-agent' });
    const deps = {
      meshCore: { getSubjectByPath, getByPath } as unknown as McpToolDeps['meshCore'],
    } as McpToolDeps;

    const identity = resolveSenderIdentity(deps, '/projects/my-agent');

    expect(getSubjectByPath).toHaveBeenCalledWith('/projects/my-agent');
    expect(getByPath).not.toHaveBeenCalled();
    expect(identity).toEqual({ subject: 'relay.agent.team.a1', agentId: 'a1' });
  });

  it('falls back to a non-agent session identity when cwd has no registered agent', () => {
    const deps = {
      meshCore: {
        getSubjectByPath: vi.fn().mockReturnValue(undefined),
      } as unknown as McpToolDeps['meshCore'],
    } as McpToolDeps;

    const identity = resolveSenderIdentity(deps, '/tmp/scratch');
    // basename + a short hash of the FULL cwd (DOR-514), not bare
    // `path.basename(cwd)` — see the next test for why the hash suffix is the
    // whole point, and this fixture's own module doc for why the basename
    // stays legible rather than being hashed away entirely.
    expect(identity.subject).toBe('relay.session.scratch-e549f2e8');
    expect(identity.agentId).toBeUndefined();
  });

  it('gives two projects that share a leaf directory name distinct identities (DOR-514)', () => {
    // Before this, the non-agent session subject was `relay.session.${
    // path.basename(cwd)}`, so `/a/project` and `/b/project` — two unrelated
    // directories that happen to share a leaf name — collided on one identity.
    // No agent ACL rule keys on this subject, so the collision was mild rather
    // than the in-session escalation DOR-506 closed, but it is cheap to fix.
    const deps = {
      meshCore: {
        getSubjectByPath: vi.fn().mockReturnValue(undefined),
      } as unknown as McpToolDeps['meshCore'],
    } as McpToolDeps;

    const a = resolveSenderIdentity(deps, '/a/project');
    const b = resolveSenderIdentity(deps, '/b/project');

    expect(a.subject).not.toBe(b.subject);
    // Both keep the shared leaf name legible — only the hash suffix differs —
    // so a person reading a session-origin label still sees "project-…", not
    // an opaque hash with no relation to the directory it came from.
    expect(a.subject.startsWith('relay.session.project-')).toBe(true);
    expect(b.subject.startsWith('relay.session.project-')).toBe(true);
  });

  it('uses the external principal when there is no session (undefined cwd)', () => {
    const identity = resolveSenderIdentity({} as McpToolDeps, undefined);
    expect(identity.subject).toBe(EXTERNAL_MCP_SENDER);
    expect(identity.agentId).toBeUndefined();
  });
});

/** A second agent, whose ownership must never be listed. */
const OTHER: SenderIdentity = { subject: 'relay.agent.other', agentId: 'other' };
describe('relay_list_endpoints does not hand out owners', () => {
  it('omits owner from every listed endpoint', async () => {
    // Agents need it for nothing, and naming every mailbox's owner in one
    // unrestricted call is the reconnaissance step for targeting one.
    const deps = makeMockDeps({
      listEndpoints: vi.fn().mockReturnValue([
        {
          subject: 'relay.inbox.dispatch.theirs',
          hash: 'relay.inbox.dispatch.theirs',
          maildirPath: '/tmp/x',
          registeredAt: new Date().toISOString(),
          owner: OTHER.subject,
        },
      ]),
    });
    const result = await createRelayListEndpointsHandler(deps)();
    const data = JSON.parse(result.content[0].text) as {
      endpoints: Array<Record<string, unknown>>;
    };
    expect(data.endpoints).toHaveLength(1);
    expect(data.endpoints[0]).not.toHaveProperty('owner');
    expect(data.endpoints[0].subject).toBe('relay.inbox.dispatch.theirs');
  });
});

describe('getRelayTools', () => {
  it('lists only the two relay tools agents still have', () => {
    const tools = getRelayTools(makeMockDeps({}), SENDER) as unknown as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['relay_list_endpoints', 'relay_notify_user']);
  });
});
