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
import { useCallback } from 'react';
import { Check, Copy, RotateCw, X } from 'lucide-react';
import { useCopyFeedback } from '@/layers/shared/lib';
import type { UpdateReadiness } from './use-update-ready';

/** The command that updates a web/CLI install, offered by the pill. */
const UPDATE_COMMAND = 'npm update -g dorkos';

/** Shared by both shapes of the pill, so the amber reads the same either way. */
const PILL_CLASSES =
  'focus-ring inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors duration-150 hover:bg-amber-500/25 dark:text-amber-300';

/**
 * What the copy button says this frame.
 *
 * Three states, and the failure is one of them: a clipboard the browser refused
 * used to read as a success, because the write was never awaited.
 *
 * @param version - The version the command installs.
 * @param copied - Whether the write just succeeded.
 * @param failed - Whether the write just failed.
 */
function copyLabel(version: string, copied: boolean, failed: boolean): string {
  if (copied) return 'Command copied';
  if (failed) return "Couldn't copy";
  return `Update ready — v${version}`;
}

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
  // The pill is its own feedback: it morphs into "Command copied" and back, so
  // this is the inline variant rather than the toast one. It used to hold its
  // own `copied` flag and its own revert timer, and it never awaited the
  // clipboard write — a refused clipboard still said "Command copied" and the
  // person pasted whatever was there before (DOR-1391). The shared hook awaits
  // the write, tells success and failure apart, and clears its timer on unmount
  // for the case this component always cared about: the pill leaves the moment
  // the dismissal lands.
  const { copied, failed, copy } = useCopyFeedback();

  const handleCopy = useCallback(() => {
    void copy(UPDATE_COMMAND);
  }, [copy]);

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
        {copyLabel(update.latestVersion, copied, failed)}
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
