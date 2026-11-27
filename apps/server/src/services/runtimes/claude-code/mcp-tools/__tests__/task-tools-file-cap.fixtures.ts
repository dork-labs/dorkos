/**
 * Shared pieces of the `tasks_update` file-cap suite.
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';

/**
 * Run one turn in a chat set to `stored`, so the chat has a real recorded level
 * (S-B), and its marks when `opts` carries them.
 *
 * @param sessionId - The chat.
 * @param stored - The level the chat is set to.
 * @param opts - The send options, marks included.
 */
export async function ranTurn(sessionId: string, stored: string, opts?: Record<string, unknown>) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => stored
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts as never)) {
    // drain
  }
}
