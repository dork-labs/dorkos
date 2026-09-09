/**
 * The tools whose files are in this folder that DorkOS is not sharing to.
 *
 * @module entities/harness/ui/NotEnabledNotice
 */
import { Fragment } from 'react';
import type { HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { HARNESS_LABELS } from '@dorkos/shared/harness-schemas';
import { InlineCode } from '@/layers/shared/ui';

/** What a {@link NotEnabledNotice} draws. */
export interface NotEnabledNoticeProps {
  /** The tools DorkOS found signs of and is not sharing to. */
  notEnabled: HarnessStatusResponse['notEnabled'];
}

/**
 * A command that wraps at its spaces and nowhere else.
 *
 * At the docked panel's narrowest this line broke inside a flag — `dorkos
 * harness sync --` / `fix --enable gemini` — and half a flag is worse than no
 * flag, because somebody retyping it off the screen gets a command that fails.
 * Cancelling `InlineCode`'s `break-all` was not enough on its own: a hyphen is a
 * break opportunity in its own right, so `--fix` still split after the dashes.
 * Each token is its own non-breaking box instead, which leaves the spaces
 * already between them as the only places a line can end.
 *
 * The alternative — one unbreakable line in a scrolling box — hides the end of
 * the command behind a gesture, and this is the only copy of it on the page.
 *
 * @param command - The whole command, tokens separated by single spaces.
 */
function WrappableCommand({ command }: { command: string }) {
  return (
    <InlineCode className="break-normal">
      {command.split(' ').map((token, index) => (
        <Fragment key={`${index}-${token}`}>
          {index > 0 && ' '}
          <span className="whitespace-nowrap">{token}</span>
        </Fragment>
      ))}
    </InlineCode>
  );
}

/**
 * One line per tool DorkOS found in the folder but is not sharing to, and the
 * command that turns it on.
 *
 * **Copy, not a button** (D24). `--enable` writes
 * `.agents/harness.manifest.json`, a file that is committed and shared with
 * everybody on the project. A button in a side panel that edits a committed file
 * with no diff and no undo promises more than the fact it fixes; typing the
 * command puts the person in the folder, where `git diff` is one keystroke away.
 *
 * The signal that gave the tool away rides the line's `title`, so "how do you
 * know?" has an answer without spending a line on it.
 */
export function NotEnabledNotice({ notEnabled }: NotEnabledNoticeProps) {
  if (notEnabled.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 py-1">
      {notEnabled.map(({ harness, signal }) => (
        <div key={harness} title={signal} className="flex flex-col gap-0.5">
          <p className="text-xs font-medium">
            {HARNESS_LABELS[harness]} files are in this folder, but DorkOS isn’t sharing to it.
          </p>
          <p className="text-muted-foreground text-3xs">
            Run <WrappableCommand command={`dorkos harness sync --fix --enable ${harness}`} /> in
            this folder to turn it on.
          </p>
        </div>
      ))}
    </div>
  );
}
