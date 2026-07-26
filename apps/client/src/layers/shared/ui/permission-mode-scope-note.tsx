import { cn, isBypassPermissionMode } from '@/layers/shared/lib';

export interface PermissionModeScopeNoteProps {
  /** The permission mode currently selected. Anything that still asks renders nothing. */
  mode: string | null | undefined;
  /** Extra classes for the surrounding paragraph. */
  className?: string;
}

/**
 * What a "run everything" permission mode does NOT cover, said where the mode is
 * chosen (spec `agent-approval-settings` §3.7).
 *
 * ## The surprise this exists to prevent
 *
 * Turning a bypass mode on reads as "stop asking me", and for tools inside the
 * session that is exactly what it does. It does nothing to the approvals DorkOS
 * asks for on its own behalf — removing an installed package still stops and
 * waits. Somebody who learns that from a card appearing after they thought they
 * had switched asking off has been misled by the product, even though every
 * individual screen was accurate.
 *
 * So the sentence appears at the moment of the choice, in all three places a
 * permission mode is actually picked: the session status line, a channel binding,
 * and a scheduled task. One component and one condition
 * ({@link isBypassPermissionMode}), so the three cannot drift into saying
 * different things.
 *
 * Deliberately quiet: muted body text, no icon, no color. It is a clarification,
 * not a warning — the warning about the mode itself already exists next to it,
 * and two alarms about one setting teach a person to read neither.
 */
export function PermissionModeScopeNote({ mode, className }: PermissionModeScopeNoteProps) {
  if (!isBypassPermissionMode(mode)) return null;
  return (
    <p
      data-slot="permission-mode-scope-note"
      className={cn('text-muted-foreground text-xs', className)}
    >
      This covers tools inside the session. Actions on DorkOS itself, like removing packages, still
      ask. Change that in Settings, under Security.
    </p>
  );
}
