/**
 * The per-call ceiling the in-session `dorkos` MCP server declares for itself
 * (SDK 0.3.248), replacing the `MCP_TOOL_TIMEOUT` floor DorkOS used to write
 * into every turn's subprocess environment (DOR-987).
 *
 * Two things have to hold and neither is obvious from reading one file: the
 * number must be DERIVED from the approval hold rather than picked, so moving
 * the hold moves it; and it must actually reach the server config, because a
 * ceiling the SDK never sees is no ceiling at all.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import { createDorkOsToolServer } from '../index.js';
import { DORKOS_MCP_TOOL_TIMEOUT_MS, RELAY_SEND_AND_WAIT_MAX_MS } from '../tool-timeout.js';
import { CAPABILITY_APPROVAL_HOLD_CAP_MS } from '../../../../core/capabilities/capability-approval-hold.js';
import { CAPABILITY_HOLD_PAUSE_GRACE_MS } from '../../../../session/session-state-projector.js';
import { NotifyBudget } from '../../../../relay/notify-budget.js';
import type { McpToolDeps } from '../types.js';

/** Minimal deps — this file builds the server only to read its config. */
function createDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dorkos-tool-timeout',
    dorkHome: '/tmp/dorkos-test-home',
    taskStore: stub,
    relayCore: stub,
    adapterManager: stub,
    traceStore: stub,
    bindingStore: stub,
    bindingRouter: stub,
    meshCore: stub,
    extensionManager: stub,
    runtimeRegistry: stub,
    activityService: stub,
    notifyBudget: new NotifyBudget(),
  };
}

describe('DORKOS_MCP_TOOL_TIMEOUT_MS', () => {
  it('is the larger minutes-long budget plus the grace, not a number somebody chose', () => {
    // The whole point of the ceiling is that the two long calls fit inside one
    // tool call. Written as the derivation so raising either budget raises this
    // with it; a literal would drift the first time one moved and nothing would
    // say so until a person's approval, or an agent's reply, came back an error.
    expect(DORKOS_MCP_TOOL_TIMEOUT_MS).toBe(
      Math.max(CAPABILITY_APPROVAL_HOLD_CAP_MS, RELAY_SEND_AND_WAIT_MAX_MS) +
        CAPABILITY_HOLD_PAUSE_GRACE_MS
    );
  });

  it('clears a held approval running its full cap', () => {
    expect(DORKOS_MCP_TOOL_TIMEOUT_MS).toBeGreaterThan(CAPABILITY_APPROVAL_HOLD_CAP_MS);
  });

  it('clears a relay wait asked for at its advertised maximum', () => {
    // Before the server had a timeout of its own, this call inherited the CLI's
    // ~27.8h default and was effectively unbounded. A ceiling derived from the
    // approval hold alone would have been the first thing ever to cut it short.
    expect(DORKOS_MCP_TOOL_TIMEOUT_MS).toBeGreaterThan(RELAY_SEND_AND_WAIT_MAX_MS);
  });

  it('clears the SDK floor below which a per-server timeout is silently ignored', () => {
    // Under 1000ms the SDK drops the option and falls back to MCP_TOOL_TIMEOUT —
    // the exact situation this replaced, arrived at without an error.
    expect(DORKOS_MCP_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('createDorkOsToolServer', () => {
  it('declares that ceiling on the server config the SDK reads', () => {
    const server = createDorkOsToolServer(createDeps()) as unknown as { timeout?: number };

    expect(server.timeout).toBe(DORKOS_MCP_TOOL_TIMEOUT_MS);
  });
});
