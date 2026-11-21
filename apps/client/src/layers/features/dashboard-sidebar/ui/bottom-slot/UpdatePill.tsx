/**
 * The transient update pill (BC-44).
 *
 * Present only while there is something to say about an update. On the desktop
 * app that means a download in progress or one that failed (DOR-4846), a
 * downloaded update waiting for a restart, or one that was staged and then
 * failed to install; on a web or CLI install it means a newer
 * published version, and the pill hands over the one command that installs it.
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
import { Check, Copy, Download, RotateCw, X } from 'lucide-react';
import { cn, useCopyFeedback } from '@/layers/shared/lib';
import { Progress } from '@/layers/shared/ui';
import type { UpdateReadiness } from './use-update-ready';

/** The command that updates a web/CLI install, offered by the pill. */
const UPDATE_COMMAND = 'npm update -g dorkos';

/**
 * What the card says when an update was staged and then did not install.
 *
 * Three jobs in two sentences: name what went wrong without blaming the person,
 * give the one action that works, and answer the question anybody asked to
 * reinstall an app immediately has — whether they lose their work. Never
 * "Squirrel", never a version number they cannot act on.
 */
const INSTALL_FAILED_COPY =
  'The update couldn’t install itself. Download a fresh copy. Your settings and agents stay put.';

/**
 * What the card says while an update downloads (DOR-4846). Names the real
 * version, so a person who saw "available" knows this is that one.
 *
 * @param version - The version downloading, or `null` from an older shell.
 */
function downloadingCopy(version: string | null): string {
  return version ? `Downloading ${version}…` : 'Downloading the update…';
}

/**
 * What the card says when a download stopped: what happened, then the likely
 * fix. The button beside it is the retry.
 *
 * @param version - The version that failed to download.
 */
function downloadFailedCopy(version: string): string {
  return `Couldn’t download ${version}. Check your connection and try again.`;
}

/** The shape every pill here shares; the colour says how much it asks for. */
const PILL_SHAPE =
  'focus-ring inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium transition-colors duration-150';

/**
 * The bright pill: the restart, and the web/CLI update command. Only one
 * desktop state is bright, the one where there is something to do now.
 */
const PILL_CLASSES = cn(
  PILL_SHAPE,
  'bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300'
);

/** The quiet pill: a remedy after something went wrong, not a nudge. */
const QUIET_PILL_CLASSES = cn(
  PILL_SHAPE,
  'bg-foreground/10 text-sidebar-foreground hover:bg-foreground/15'
);

/**
 * The progress track. The shared bar's default track all but vanishes on the
 * light sidebar; this is the tone dark already reads as.
 */
const PROGRESS_TRACK_CLASSES = 'h-1 bg-foreground/10';

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
  if (failed) return 'Couldn’t copy';
  return `Update ready: v${version}`;
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

  if (update.kind === 'desktop-downloading') {
    // Quiet on purpose: nothing to press yet. The bright pill is kept for the
    // restart, the one moment the person has something to do.
    const label = downloadingCopy(update.version);
    return (
      <div role="group" aria-label="Update downloading" className="flex flex-col gap-1.5 px-0.5">
        <div className="text-sidebar-foreground/70 text-2xs flex items-center justify-between gap-2">
          <span className="truncate">{label}</span>
          {update.percent !== null && (
            <span className="shrink-0 tabular-nums">{Math.floor(update.percent)}%</span>
          )}
        </div>
        {/* An empty track before the first report, so both downloading states look alike. */}
        <Progress
          value={update.percent ?? 0}
          aria-label={label}
          className={PROGRESS_TRACK_CLASSES}
        />
      </div>
    );
  }

  if (update.kind === 'desktop-download-failed') {
    return (
      <div
        role="group"
        aria-label="Update didn’t download"
        className="flex flex-col gap-1.5 px-0.5"
      >
        <p className="text-sidebar-foreground/70 text-2xs leading-snug">
          {downloadFailedCopy(update.version)}
        </p>
        <button
          type="button"
          onClick={update.retry}
          aria-label={`Try downloading ${update.version} again`}
          className={cn(QUIET_PILL_CLASSES, 'self-start')}
        >
          <RotateCw className="size-(--size-icon-xs)" />
          Try again
        </button>
      </div>
    );
  }

  if (update.kind === 'desktop-restart') {
    return (
      <div className="flex items-center px-0.5">
        <button
          type="button"
          onClick={update.restart}
          aria-label="Restart to install the update"
          className={PILL_CLASSES}
        >
          <RotateCw className="size-(--size-icon-xs)" />
          Restart to update
        </button>
      </div>
    );
  }

  if (update.kind === 'desktop-install-failed') {
    // The only shape here that needs a sentence: "Download fresh copy" alone
    // would read as an offer rather than as the answer to something that went
    // wrong, and it is the reassurance — nothing is lost — that decides whether
    // anyone clicks it.
    return (
      <div role="group" aria-label="Update didn’t install" className="flex flex-col gap-1.5 px-0.5">
        <p className="text-sidebar-foreground/70 text-2xs leading-snug">{INSTALL_FAILED_COPY}</p>
        <button
          type="button"
          onClick={update.downloadFresh}
          aria-label="Download a fresh copy of DorkOS"
          className={cn(QUIET_PILL_CLASSES, 'self-start')}
        >
          <Download className="size-(--size-icon-xs)" />
          Download fresh copy
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-0.5">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy the update command for v${update.latestVersion}`}
        className={PILL_CLASSES}
      >
        {copied ? (
          <Check className="size-(--size-icon-xs)" />
        ) : (
          <Copy className="size-(--size-icon-xs)" />
        )}
        {copyLabel(update.latestVersion, copied, failed)}
      </button>
      <button
        type="button"
        onClick={update.dismiss}
        aria-label="Dismiss update notification"
        className="text-sidebar-foreground/70 hover:text-sidebar-foreground focus-ring rounded-md p-0.5 transition-colors duration-150"
      >
        <X className="size-(--size-icon-xs)" />
      </button>
    </div>
  );
}
