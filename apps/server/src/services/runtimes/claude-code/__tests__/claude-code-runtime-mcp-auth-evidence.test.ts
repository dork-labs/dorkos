/**
 * The runtime edge of the revocation watch (DOR-981): what a turn's MCP status
 * snapshot actually hands the mesh.
 *
 * The rest of the feature is covered against the mesh's own port. This file
 * covers the seam BEFORE it — the `onMcpStatusReceived` composition inside
 * `sendMessage` — because that is where the original P0 lived. The first version
 * forwarded only `needs-auth`, which the shipped CLI never reports for a
 * bearer-carrying server, so the whole feature was unreachable in production
 * while every mesh-level test passed. A pure-function assertion on the filter
 * cannot catch that: the filter has to be WIRED to the turn.
 *
 * So this drives a real `ClaudeCodeRuntime.sendMessage`, captures the callbacks
 * it hands the SDK sender, and invokes the status callback exactly as the SDK
 * does when `mcpServerStatus()` answers.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerEntry } from '@dorkos/shared/transport';

import type { McpAuthEvidence } from '../../../mesh/mcp-revocation.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(), renameSession: vi.fn() }));
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

/**
 * The captured `executeSdkQuery` options — how the turn is configured, including
 * the status callback under test. Stubbed as an empty generator: nothing here
 * cares what a turn streams, only what it was wired with.
 */
const { captured, executeSdkQuery } = vi.hoisted(() => {
  const captured: { opts?: Record<string, unknown> } = {};
  return {
    captured,
    executeSdkQuery: vi.fn(
      (
        _sessionId: string,
        _content: string,
        _session: unknown,
        opts: Record<string, unknown>
      ): AsyncIterable<never> => {
        captured.opts = opts;
        return { [Symbol.asyncIterator]: async function* () {} };
      }
    ),
  };
});
vi.mock('../messaging/message-sender.js', () => ({ executeSdkQuery }));

/** The status callback the SDK invokes when `mcpServerStatus()` answers. */
type StatusCallback = (servers: McpServerEntry[]) => void;

const SESSION_ID = 'sess-1';
const AGENT_CWD = '/projects/agent-workspace';

describe('the MCP status snapshot a turn hands the revocation watch', () => {
  let runtime: import('../claude-code-runtime.js').ClaudeCodeRuntime;
  let reported: McpAuthEvidence[];

  beforeEach(async () => {
    vi.clearAllMocks();
    captured.opts = undefined;
    const { ClaudeCodeRuntime } = await import('../claude-code-runtime.js');
    runtime = new ClaudeCodeRuntime('/tmp/dorkos-test', '/tmp/default-cwd');
    reported = [];
    runtime.setMcpAuthEvidence((evidence) => reported.push(evidence));
    runtime.ensureSession(SESSION_ID, { permissionMode: 'default' });
  });

  /** Run a turn and hand back the status callback it wired. */
  async function statusCallback(): Promise<StatusCallback> {
    for await (const _event of runtime.sendMessage(SESSION_ID, 'hello', { cwd: AGENT_CWD })) {
      void _event;
    }
    const cb = captured.opts?.onMcpStatusReceived;
    expect(typeof cb).toBe('function');
    return cb as StatusCallback;
  }

  it('forwards every server that did not come up, with the session and its directory', async () => {
    const onStatus = await statusCallback();

    onStatus([
      // The headline case: a DorkOS-injected bearer the server refused. Observed
      // live as `failed` — see the fixture beside `mcp-revocation.test.ts`.
      { name: 'granola', type: 'http', status: 'failed' },
      // The tokenless refusal. Also worth looking at, never worth trusting.
      { name: 'linear', type: 'http', status: 'needs-auth' },
      // Not evidence: still connecting, switched off, or working.
      { name: 'slow-one', type: 'http', status: 'pending' },
      { name: 'switched-off', type: 'stdio', status: 'disabled' },
      { name: 'healthy', type: 'http', status: 'connected' },
    ]);

    // Narrowing the trigger back to `needs-auth` — the shipped P0 — drops
    // `granola` here and reddens this.
    expect(reported).toEqual([
      { sessionId: SESSION_ID, cwd: AGENT_CWD, serverNames: ['granola', 'linear'] },
    ]);
  });

  it('stays quiet when every server connected', async () => {
    const onStatus = await statusCallback();

    onStatus([{ name: 'granola', type: 'http', status: 'connected' }]);

    expect(reported).toEqual([]);
  });

  it('still fills the runtime cache the snapshot was fetched for', async () => {
    // The port is COMPOSED over the cache's own handler, not substituted for it.
    // Replacing it would silently blind `/api/mcp-config` and the MCP App
    // resource reads, which are the snapshot's original readers.
    const onStatus = await statusCallback();

    onStatus([{ name: 'granola', type: 'http', status: 'failed' }]);

    expect(runtime.getMcpStatus(AGENT_CWD)).toEqual([
      { name: 'granola', type: 'http', status: 'failed' },
    ]);
  });

  it('does nothing when no port is wired', async () => {
    runtime.setMcpAuthEvidence(undefined);
    const onStatus = await statusCallback();

    expect(() => onStatus([{ name: 'granola', type: 'http', status: 'failed' }])).not.toThrow();
    expect(reported).toEqual([]);
  });
});
