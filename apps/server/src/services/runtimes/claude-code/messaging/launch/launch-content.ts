/** Final launch prompt selection shared by the launch resolver's dispatch paths. */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { enrichContent } from '../../enrich-content.js';

/**
 * Keep real slash commands bare, and enrich ordinary messages with their context.
 * @param content - Original message words.
 * @param messageOpts - The unchanged message's additional-context bag.
 * @param isCommandDispatch - Whether the resolver recognized a command dispatch.
 * @param untrustedText - Whether the message words require native interpretation defusing.
 */
export function launchPrompt(
  content: string,
  messageOpts: Pick<MessageOpts, 'additionalContext'> | undefined,
  isCommandDispatch: boolean,
  untrustedText: boolean
): string {
  if (isCommandDispatch) {
    // DOR-107: a `/`-prefixed prompt must reach the CLI bare (leading whitespace
    // also breaks command parsing). NO context prepend on command turns. Retained.
    return content.trim();
  }
  // Context blocks defused always, the words when somebody other than the
  // person here wrote them (DOR-2955, `enrich-content.ts`).
  return enrichContent(content, messageOpts?.additionalContext, untrustedText);
}
