/**
 * The user message Claude Code is sent: the turn's context blocks, then the words (DOR-2955).
 *
 * One place for it, because two paths build it (a turn's launch, and a message steered or staged
 * into a running one) and both must defuse the same way. Every context block is defused: other
 * people's words and names ride in them, nobody types into one, and Claude Code reads an `@`
 * anywhere in the message. The words themselves are defused only when somebody other than the
 * person here wrote them (`@dorkos/shared/untrusted-text`).
 *
 * @module services/runtimes/claude-code/enrich-content
 */
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import { defuseFileReferences, defuseUntrustedPrompt } from '@dorkos/shared/untrusted-text';
import { renderContextEntry } from './messaging/context-builder.js';

/**
 * Prepend the rendered, defused context blocks to the words; the words alone when there are
 * none. The words passed in are never changed in place.
 *
 * @param content - The words of the message, as written.
 * @param additionalContext - The neutral context bag, if any.
 * @param untrusted - Whether somebody other than the person here wrote the words.
 */
export function enrichContent(
  content: string,
  additionalContext: AdditionalContext | undefined,
  untrusted: boolean
): string {
  const blocks = (additionalContext ?? [])
    .map(renderContextEntry)
    .filter(Boolean)
    .map(defuseFileReferences);
  const words = untrusted ? defuseUntrustedPrompt(content) : content;
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n\n${words}` : words;
}
