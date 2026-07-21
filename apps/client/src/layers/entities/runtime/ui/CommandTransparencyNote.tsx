import { CopyButton } from '@/layers/shared/ui';

interface CommandTransparencyNoteProps {
  /** The exact shell command the one-click action runs on the user's machine. */
  command: string;
}

/**
 * Muted fine print that states exactly what a one-click action runs on the
 * user's machine, with a copy affordance.
 *
 * This is the honesty counterpart to a "do-it-for-them" button: the button does
 * the work, and this line tells the user precisely what ran (or would run) so
 * nothing happens behind their back. The only manual affordance on the default
 * connect path — the full terminal walkthrough still lives in the Advanced
 * disclosure.
 */
export function CommandTransparencyNote({ command }: CommandTransparencyNoteProps) {
  return (
    <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
      <span className="min-w-0">
        Runs <code className="text-2xs break-all">{command}</code> on this machine
      </span>
      <CopyButton value={command} label={`Copy command: ${command}`} className="shrink-0" />
    </p>
  );
}
