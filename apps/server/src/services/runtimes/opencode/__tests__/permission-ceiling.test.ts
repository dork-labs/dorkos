/**
 * A turn somebody from off this machine started runs no higher than its ceiling on OpenCode
 * (spec `official-community-space` D10). OpenCode reads the session's mode live, at every ask,
 * so the ceiling is applied there: a session at Full autonomy still asks before that turn acts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalEvent, StreamEvent } from '@dorkos/shared/types';
import {
  enforceApprovals,
  PendingApprovalStore,
  type ApprovalGateDeps,
} from '../messaging/approvals.js';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import type { OpenCodeSessionRegistry } from '../sessions/session-registry.js';

const respond = vi.fn(async () => ({ data: true }));
const provider = {
  getClient: async () => ({ postSessionIdPermissionsPermissionId: respond }),
  peekClient: () => null,
} as unknown as OpenCodeClientProvider;

const BASH_ASK: StreamEvent = {
  type: 'approval_required',
  data: {
    toolCallId: 'per_1',
    timeoutMs: 1000,
    startedAt: 0,
    toolName: 'bash',
    input: JSON.stringify({ command: 'rm -rf build' }),
  } as ApprovalEvent,
} as StreamEvent;

/** Run one bash ask through the gate for a session at `mode`, with or without a ceiling. */
async function ask(mode: string, permissionCeiling?: string): Promise<StreamEvent[]> {
  const gate: ApprovalGateDeps = {
    provider,
    approvals: new PendingApprovalStore(),
    registry: { get: () => ({ permissionMode: mode }) } as unknown as OpenCodeSessionRegistry,
  };
  const out: StreamEvent[] = [];
  for await (const event of enforceApprovals(
    gate,
    {
      sessionId: 's1',
      ocSessionId: 'oc-1',
      cwd: '/agents/ana',
      permissions: { pendingPermissionSessions: new Map() } as never,
      ...(permissionCeiling ? { permissionCeiling } : {}),
    },
    BASH_ASK
  )) {
    out.push(event);
  }
  gate.approvals.clearSession('s1');
  return out;
}

afterEach(() => {
  respond.mockClear();
});

describe('a turn with a permission ceiling on OpenCode', () => {
  it('approves on its own at Full autonomy when the turn carries no ceiling', async () => {
    const out = await ask('bypassPermissions');

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'once' } }));
    expect(out).toEqual([]);
  });

  it('asks the person instead when a stranger’s turn carries the ceiling', async () => {
    const out = await ask('bypassPermissions', 'default');

    expect(respond).not.toHaveBeenCalled();
    expect(out.map((event) => event.type)).toEqual(['approval_required']);
  });
});
