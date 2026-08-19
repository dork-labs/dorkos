/**
 * One line of DorkBot's scripted narration, drawn as a real message row.
 *
 * The onboarding conversation is the third host of `Message.*`, beside the
 * session transcript and a room's feed, and it composes the parts itself for
 * the same reason the other two do: a host supplies who is speaking and how to
 * draw what they said, and everything around that — the grid, the identity
 * gutter, the group rhythm, the author line — is the one shared row.
 *
 * **It composes the parts rather than borrowing the session's row**, which is
 * what lets `widgets/session` own that row. Onboarding is a feature and the
 * session's row is a widget's; a feature may not import a widget
 * (`.claude/rules/fsd-layers.md`), so borrowing it pinned the row — and its
 * body renderer — in `features/chat` for the whole of the unified-conversation
 * programme (`specs/unified-conversation/04-implementation.md`, Known Issue
 * 29). Composing `Message.*` here is features ← features, which is legal, and
 * it is the change the programme named as the one that frees the row.
 *
 * Nothing is lost by not being the session's row: every branch of it that a
 * scripted line could reach was already switched off. `presentation` suppressed
 * the timestamp, the hover background and the hover capsule;
 * `NARRATION_CAPABILITIES` turns off everything the compound offers; and the
 * body renderer's assistant path for a lone text part is exactly the
 * `msg-assistant` wrapper and {@link StreamingText} call this makes.
 *
 * @module features/onboarding/ui/NarrationMessage
 */
import { useId } from 'react';
import type { ChatMessage, MessageAuthor, MessageGrouping } from '@/layers/shared/model';
import { Message } from '@/layers/features/conversation';
import { StreamingText } from '@/layers/features/chat';

/** What one narrated line needs to draw itself. */
export interface NarrationMessageProps {
  /** The scripted line, as `buildScriptMessage` minted it. */
  message: ChatMessage;
  /** Where this line sits in its run of same-speaker lines. */
  grouping: MessageGrouping;
  /** Who is speaking — DorkBot, with whatever face the registry has resolved. */
  author: MessageAuthor;
}

/**
 * A narrated line: the shared row, with markdown inside it and nothing to press.
 *
 * Every scripted line is DorkBot's — the conversation's reducer enqueues them
 * all as `assistant` — so the row takes the assistant's typography and the
 * body takes the assistant's renderer. There is no user branch because the
 * script has no user lines; the person's first message dissolves the overlay
 * into a real session rather than landing here.
 *
 * The row is named the way the session's and the room's are: by the author line
 * already on screen for a group start, and by a written label for a
 * continuation, whose author line the design deliberately drops. No timestamp
 * either way — a clock reading would make a line of a story read as something
 * somebody just typed.
 */
export function NarrationMessage({ message, grouping, author }: NarrationMessageProps) {
  const domId = useId();
  const headerId = `${domId}-author`;
  const contentId = `${domId}-content`;
  const showAuthorHeader = grouping.position === 'first' || grouping.position === 'only';

  return (
    <Message.Root
      // No `role` variant: the row's default IS the assistant's typography,
      // and every scripted line is DorkBot's. No `actions` either, so the row
      // renders no menu at all rather than an empty one.
      position={grouping.position}
      data-testid="message-item"
      {...(showAuthorHeader
        ? { 'aria-labelledby': headerId }
        : { 'aria-label': author.displayName })}
      aria-describedby={contentId}
      className="hover:bg-transparent"
    >
      <Message.Gutter author={author} />
      <Message.Body>
        <Message.Author id={headerId} author={author} />
        <Message.Content id={contentId}>
          {/* The assistant's typography, from the same class the session's body
              renderer wraps its text parts in — the narration and a real reply
              read identically because they are styled by one rule. */}
          <div className="msg-assistant">
            <StreamingText content={message.content} />
          </div>
        </Message.Content>
      </Message.Body>
    </Message.Root>
  );
}
