/**
 * `ask_owner`, the DorkOS tool a teammate's turn asks the agent's owner for one tool call with
 * (DOR-2956, `core/turn-power/ask-owner.ts`). Listed only for a process launched for a
 * teammate's turn, and not on the external `/mcp` server.
 *
 * It never waits: the owner gets a card, the room is told "I've asked my owner.", and the turn
 * is told to end. If the owner allows it, a fresh turn makes the call and posts the result.
 *
 * @module services/runtimes/claude-code/mcp-tools/ask-owner-tool
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { askOwner } from '../../../core/turn-power/ask-owner.js';
import type { McpToolSession } from './types.js';
import { jsonContent } from './types.js';

/** The answer outside a teammate's turn, or when the turn does not know who asked. */
const NOT_A_TEAMMATE_TURN = {
  error: 'Only a turn a teammate in a space started can ask the owner this way.',
  code: 'NOT_A_TEAMMATE_TURN',
};

/**
 * The `ask_owner` tool, bound to the session it runs in.
 *
 * @param session - The session, read at call time for its teammate tier and id.
 */
export function getAskOwnerTools(
  session: Pick<McpToolSession, 'teammateTier' | 'sdkSessionId'> | undefined
) {
  return [
    tool(
      'ask_owner',
      'Ask your owner to allow ONE tool call a teammate needs that this turn cannot make, such as a Bash command. Give the exact tool and input. Your owner sees a card with exactly that; this turn then ends. If they allow it, a new turn makes that call and posts the result in this room. Never for connected apps.',
      {
        tool: z.string().min(1).max(64).describe('The tool name, e.g. Bash, Read, Edit, WebFetch'),
        input: z.record(z.string(), z.unknown()).describe('The exact input for that tool'),
        why: z.string().min(1).max(500).describe('In one sentence, why the teammate needs it'),
      },
      async ({ tool: name, input, why }) => {
        const tier = session?.teammateTier;
        if (!tier?.authorId || !tier.asker || tier.passTurn) {
          return jsonContent(NOT_A_TEAMMATE_TURN, true);
        }
        const result = await askOwner(
          {
            roomId: tier.roomId,
            authorId: tier.authorId,
            asker: tier.asker,
            ...(session?.sdkSessionId ? { sessionId: session.sdkSessionId } : {}),
          },
          { tool: name, input, why }
        );
        return result.ok
          ? jsonContent({ asked: true, message: result.message })
          : jsonContent({ error: result.message, code: 'ASK_REFUSED' }, true);
      }
    ),
  ];
}
