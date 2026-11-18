import { expect, vi } from 'vitest';
import type { OpencodeClient, GlobalEvent } from '@opencode-ai/sdk';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { driveApprovalTurn } from '../../../session/__tests__/durable-turn-harness.js';
import {
  heldApprovalProbes,
  type ApprovalProbes,
} from '../../../session/__tests__/held-approval-proof.js';
import { TurnEventQueue } from '../events/global-event-hub.js';
import {
  OC_SESSION_A,
  globalEvent,
  serverConnected,
  statusEvent,
  messageUpdated,
  assistantMessage,
  partUpdated,
  toolPart,
  toolStateRunning,
  toolStateCompleted,
  toolStateError,
  permissionAsked,
  permissionRequest,
  sessionIdle,
} from './opencode-sse-fixtures.js';

/** Drive actual native permission events; withhold reply echo and terminal until the proof. */
export function openCodeApprovalTurn(
  client: OpencodeClient,
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  cwd: string,
  probes: ApprovalProbes
) {
  const queue = new TurnEventQueue<GlobalEvent>();
  const push = (event: Parameters<typeof globalEvent>[1]) => queue.push(globalEvent(cwd, event));
  let stopped = false;
  let decided!: (resolution: 'approved' | 'denied') => void;
  const resolution = new Promise<'approved' | 'denied'>((resolve) => {
    decided = resolve;
  });
  let response: 'once' | 'reject' | undefined;
  const nativeId = 'native-approval-tool';
  const permissionId = 'permission-approval-card';
  const input = { command: 'printf approval' };
  const nativeRequest = permissionRequest(OC_SESSION_A, {
    id: permissionId,
    callID: nativeId,
    permission: 'bash',
    patterns: ['printf approval'],
    metadata: input,
  });
  vi.mocked(client.global.event).mockImplementation(async (options) => {
    options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
    push(serverConnected());
    return { stream: queue } as never;
  });
  vi.mocked(client.session.promptAsync).mockImplementation(async () => {
    push(statusEvent(OC_SESSION_A, { type: 'busy' }));
    push(messageUpdated(assistantMessage(OC_SESSION_A)));
    push(partUpdated(toolPart(OC_SESSION_A, nativeId, 'bash', toolStateRunning(input))));
    push(permissionAsked(nativeRequest));
    return {} as never;
  });
  vi.mocked(client.postSessionIdPermissionsPermissionId).mockImplementation(async (request) => {
    expect(request.path).toEqual({ id: OC_SESSION_A, permissionID: permissionId });
    expect(['once', 'reject']).toContain(request.body!.response);
    response = request.body!.response as 'once' | 'reject';
    decided(response === 'once' ? 'approved' : 'denied');
    return { data: true } as never;
  });
  vi.mocked(client.session.abort).mockImplementation(async () => {
    stopped = true;
    push(sessionIdle(OC_SESSION_A));
    return { data: true } as never;
  });
  const originalAfterTurn = probes.afterTurn;
  probes = {
    ...probes,
    afterTurn: async () => {
      await originalAfterTurn();
      expect(vi.mocked(client.postSessionIdPermissionsPermissionId).mock.calls).toHaveLength(
        stopped ? 0 : 1
      );
    },
  };
  const release = () => {
    if (stopped) return;
    expect(response, 'real permission respond endpoint was reached').toBeDefined();
    push(
      partUpdated(
        toolPart(
          OC_SESSION_A,
          nativeId,
          'bash',
          response === 'once'
            ? toolStateCompleted(input, 'approved')
            : toolStateError(input, 'declined')
        )
      )
    );
    push(sessionIdle(OC_SESSION_A));
  };
  return driveApprovalTurn(
    runtime,
    sessionId,
    content,
    cwd,
    heldApprovalProbes(
      runtime,
      sessionId,
      cwd,
      {
        ...probes,
        atApproval: async (approval) => {
          expect(approval.toolCallId).toBe(nativeRequest.id);
          expect(nativeRequest.tool!.callID).not.toBe(nativeRequest.id);
          await probes.atApproval(approval, { toolCallId: nativeRequest.tool!.callID });
        },
      },
      { stopped: () => stopped, release, resolution: () => resolution }
    )
  );
}
