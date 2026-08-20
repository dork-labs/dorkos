/**
 * The transient update pill (BC-44).
 *
 * Present only while an update genuinely is ready. On the desktop app that
 * means a downloaded update waiting for a restart; on a web or CLI install it
 * means a newer published version, and the pill hands over the one command that
 * installs it.
 *
 * It lived inside `SidebarFooterStrip`, stacked above the nav row. It is a
 * candidate in the sidebar's bottom slot now, so it takes its turn against the
 * getting-started card, the profile prompt and a promo instead of adding a
 * fourth thing to the bottom of the panel (spec `sidebar-simplification` D4).
 * The decision of whether it qualifies is {@link useUpdateReady}, because the
 * slot has to know that before it draws anything.
 *
 * @module features/dashboard-sidebar/ui/bottom-slot/UpdatePill
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, RotateCw, X } from 'lucide-react';
import { TIMING } from '@/layers/shared/lib';
import type { UpdateReadiness } from './use-update-ready';

/** The command that updates a web/CLI install, offered by the pill. */
const UPDATE_COMMAND = 'npm update -g dorkos';

/** Shared by both shapes of the pill, so the amber reads the same either way. */
const PILL_CLASSES =
  'focus-ring inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors duration-150 hover:bg-amber-500/25 dark:text-amber-300';

/** Props for {@link UpdatePill}. */
export interface UpdatePillProps {
  /** What is waiting. `none` renders nothing — the slot should not have picked it. */
  update: UpdateReadiness;
}

/**
 * Draws whichever update is waiting.
 *
 * @param props - The readiness {@link useUpdateReady} resolved.
 */
export function UpdatePill({ update }: UpdatePillProps) {
  const [copied, setCopied] = useState(false);

  // The "Copied" beat clears itself, and clears its own timer on unmount: the
  // pill disappears the moment the dismissal lands, which is well inside the
  // feedback window, and a `setCopied` firing into an unmounted component is a
  // warning nobody can act on.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    []
  );

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(UPDATE_COMMAND);
    setCopied(true);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
  }, []);

  if (update.kind === 'none') return null;

  if (update.kind === 'desktop-restart') {
    return (
      <div className="flex items-center px-0.5">
        <button
          type="button"
          onClick={update.restart}
          aria-label="Restart to install the update"
          className={PILL_CLASSES}
        >
          <RotateCw className="size-3" />
          Update ready — Restart
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-0.5">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy the command that updates DorkOS to v${update.latestVersion}`}
        className={PILL_CLASSES}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? 'Command copied' : `Update ready — v${update.latestVersion}`}
      </button>
      <button
        type="button"
        onClick={update.dismiss}
        aria-label="Dismiss update notification"
        className="text-sidebar-foreground/50 hover:text-sidebar-foreground focus-ring rounded-md p-0.5 transition-colors duration-150"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
