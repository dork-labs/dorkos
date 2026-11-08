import { describe, expect, it, vi } from 'vitest';
import { enforceApprovals, PendingApprovalStore } from '../messaging/approvals.js';
import { OpenCodeSessionRegistry } from '../sessions/session-registry.js';
import type { ApprovalRouting } from '../messaging/approvals.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import { mapPermissionAsked } from '../events/session-event-mapper.js';

const roots = {
  cwd: '/probe/desk',
  data: '/probe/data',
  home: '/probe/home',
  accounts: [],
  agentFolders: ['/probe/desk'],
  agentHomes: [],
};
const turn: ApprovalRouting = {
  sessionId: 'parent',
  ocSessionId: 'oc-parent',
  cwd: roots.cwd,
  permissions: { pendingPermissionSessions: new Map([['ask', 'oc-child']]) },
  grants: [{ path: roots.data, access: 'write' }],
  protectedRoots: roots,
};
const event: StreamEvent = {
  type: 'approval_required',
  data: {
    toolCallId: 'ask',
    toolName: 'edit',
    input: JSON.stringify({ filepath: '/probe/data/config.json' }),
    timeoutMs: 1,
    startedAt: 1,
    hasSuggestions: false,
  },
};

async function collect(stream: AsyncIterable<StreamEvent>) {
  const result: StreamEvent[] = [];
  for await (const item of stream) result.push(item);
  return result;
}

describe('OpenCode native file refusals', () => {
  it('carries the child search root from its own tool call, not the pattern or a parent call', () => {
    const state = {
      pendingPermissionSessions: new Map<string, string>(),
      nativeToolInputs: new Map([
        ['oc-parent:call', { path: '/probe/parent' }],
        ['oc-child:call', { path: '/probe/child' }],
      ]),
    };
    const mapped = mapPermissionAsked(
      {
        id: 'ask',
        sessionID: 'oc-child',
        permission: 'grep',
        patterns: ['needle'],
        metadata: {},
        tool: { messageID: 'message', callID: 'call' },
      },
      state
    );
    const data = mapped[0]!.data as { input: string };
    expect(JSON.parse(data.input)).toMatchObject({ dorkosSearchRoot: '/probe/child' });
  });

  it.each(['default', 'acceptEdits', 'bypassPermissions'])(
    'beats grants in %s and replies to the child that asked',
    async (mode) => {
      const respond = vi.fn().mockResolvedValue({ data: true });
      const provider = {
        getClient: async () => ({ postSessionIdPermissionsPermissionId: respond }),
      } as unknown as OpenCodeClientProvider;
      const registry = new OpenCodeSessionRegistry();
      registry.register('parent', { permissionMode: mode });
      expect(
        await collect(
          enforceApprovals(
            { provider, registry, approvals: new PendingApprovalStore() },
            turn,
            event
          )
        )
      ).toEqual([]);
      expect(respond).toHaveBeenCalledWith({
        path: { id: 'oc-child', permissionID: 'ask' },
        body: { response: 'reject' },
      });
    }
  );

  it('never changes an undelivered refusal into an approval card', async () => {
    const provider = {
      getClient: async () => {
        throw new Error('sidecar unavailable');
      },
    } as unknown as OpenCodeClientProvider;
    await expect(
      collect(
        enforceApprovals(
          {
            provider,
            registry: new OpenCodeSessionRegistry(),
            approvals: new PendingApprovalStore(),
          },
          turn,
          event
        )
      )
    ).rejects.toThrow('sidecar unavailable');
  });
});
