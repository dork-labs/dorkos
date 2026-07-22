import { useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  InlineCode,
} from '@/layers/shared/ui';

interface CommandTransparencyNoteProps {
  /** The exact shell command the one-click action runs on the user's machine. */
  command: string;
  /** Runtime name for the friendly line, e.g. `'OpenCode'`. */
  runtimeLabel: string;
}

/**
 * The honesty counterpart to a "do-it-for-them" install button.
 *
 * Leads with plain reassurance ("We'll install OpenCode for you.") instead of a
 * raw shell command, and keeps the exact command one tap away behind a small
 * disclosure. Transparency is a product value, so the command is never hidden
 * entirely — it is always reachable, just not shouted. The disclosure is a
 * simple toggle, so it works with a tap on touch devices where a hover tooltip
 * would not.
 */
export function CommandTransparencyNote({ command, runtimeLabel }: CommandTransparencyNoteProps) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
      <p className="text-muted-foreground text-xs">
        We'll install {runtimeLabel} for you.{' '}
        <CollapsibleTrigger className="hover:text-foreground underline decoration-dotted underline-offset-2 transition-colors">
          {open ? 'Hide command' : 'What runs?'}
        </CollapsibleTrigger>
      </p>
      <CollapsibleContent className="mt-1.5 flex items-center gap-1.5">
        <InlineCode>{command}</InlineCode>
        <CopyButton value={command} label={`Copy command: ${command}`} className="shrink-0" />
      </CollapsibleContent>
    </Collapsible>
  );
}
