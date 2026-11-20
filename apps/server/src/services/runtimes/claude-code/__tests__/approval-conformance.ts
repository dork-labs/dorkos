import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { vi, type MockedFunction } from 'vitest';
import { driveApprovalTurn } from '../../../session/__tests__/durable-turn-harness.js';
import {
  heldApprovalProbes,
  type ApprovalProbes,
} from '../../../session/__tests__/held-approval-proof.js';
import { sdkToolCall, wrapSdkQuery } from './sdk-scenarios.js';

/** Drive the actual SDK permission callback, with completion held beyond the answer. */
export function claudeApprovalTurn(
  mockedQuery: MockedFunction<typeof query>,
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  probes: ApprovalProbes
) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stopped = false;
  let decided!: (resolution: 'approved' | 'denied') => void;
  const resolution = new Promise<'approved' | 'denied'>((resolve) => {
    decided = resolve;
  });
  mockedQuery.mockImplementation((args) => {
    const controller = new AbortController();
    const signal = controller.signal;
    signal.addEventListener(
      'abort',
      () => {
        stopped = true;
        release();
      },
      { once: true }
    );
    async function* scenario(): AsyncGenerator<SDKMessage> {
      for await (const event of sdkToolCall('Bash', { command: 'printf approval' }, 'finished')) {
        yield event;
        if (event.type === 'stream_event' && event.event.type === 'content_block_stop') {
          const decision = await args.options!.canUseTool!(
            'Bash',
            { command: 'printf approval' },
            {
              signal,
              requestId: 'sdk-approval-request',
              toolUseID: 'tool-call-1',
            }
          );
          if (!decision) throw new Error('SDK permission callback returned no decision');
          decided(decision.behavior === 'allow' ? 'approved' : 'denied');
          await held;
          if (stopped) return;
          yield {
            type: 'user',
            session_id: sessionId,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-call-1',
                  content: 'permission answered',
                  is_error: decision.behavior === 'deny',
                },
              ],
            },
          } as SDKMessage;
        }
      }
    }
    const stream = wrapSdkQuery(scenario());
    const stop = () => {
      stopped = true;
      controller.abort();
      release();
    };
    stream.close.mockImplementation(stop);
    Object.assign(stream, { interrupt: vi.fn(async () => stop()) });
    return stream as unknown as ReturnType<typeof query>;
  });
  return driveApprovalTurn(
    runtime,
    sessionId,
    content,
    '/projects/conformance',
    heldApprovalProbes(runtime, sessionId, '/projects/conformance', probes, {
      stopped: () => stopped,
      release,
      resolution: () => resolution,
    })
  );
}
