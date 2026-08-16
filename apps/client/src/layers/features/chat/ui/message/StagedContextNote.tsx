import { Plus } from 'lucide-react';
import { CompactResultRow } from '../primitives';

interface StagedContextNoteProps {
  /** The text the person added, shown quietly beneath the note. */
  content: string;
}

/**
 * Quiet transcript entry for a staged message (spec `persistent-session-runtime`
 * §2.5).
 *
 * A person added this while the agent was working, so it would use it on the
 * next reply, without cutting into the running turn. It is deliberately NOT a
 * message bubble: nothing replied to it, and drawing it as a turn would say
 * otherwise. It renders as a subdued row with the added text beneath, so there
 * is an honest record of what was added rather than a silent success.
 *
 * Sourced from the `context_staged` event, projected by `projectSessionMessages`
 * and routed here by `MessageList` on the message's `_stagedContext` tag.
 */
export function StagedContextNote({ content }: StagedContextNoteProps) {
  return (
    <CompactResultRow
      data-testid="staged-context-note"
      icon={<Plus aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />}
      label={<span className="text-muted-foreground">Added context for the next reply</span>}
    >
      <p className="text-muted-foreground/80 mt-1 text-xs whitespace-pre-wrap">{content}</p>
    </CompactResultRow>
  );
}
