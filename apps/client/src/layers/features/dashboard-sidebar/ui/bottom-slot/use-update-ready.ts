/**
 * Whether an update is genuinely waiting, and what the person can do about it.
 *
 * Split out of the pill itself because the sidebar's bottom slot has to know
 * whether the pill qualifies BEFORE it decides to draw it — a card that
 * self-gates to `null` cannot take part in an arbitration (spec
 * `sidebar-simplification` D4).
 *
 * **In `ui/`, not `model/`, and that is the FSD rule rather than a preference.**
 * It reads `useDesktopUpdater` from `features/session-list`, and
 * `.claude/rules/fsd-layers.md` allows a feature to reach a sibling feature only
 * for UI COMPOSITION — a `model/` segment importing another feature's hook is
 * the business-logic coupling the rule forbids. This hook exists to decide what
 * one card in the bottom slot draws, so the composition segment is where it
 * belongs.
 *
 * @module features/dashboard-sidebar/ui/bottom-slot/use-update-ready
 */
import { links, siteUrl } from '@dorkos/shared/links';
import { useCallback, useMemo } from 'react';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { isNewer, openExternalLink } from '@/layers/shared/lib';
import { useDesktopUpdater } from '@/layers/features/session-list';

/**
 * Where a person goes to replace the app by hand when its updater cannot.
 *
 * Platform-aware because the site serves a different installer per platform,
 * and handing someone the wrong one is worse than handing them nothing. Linux
 * is deliberately absent: there is no Linux desktop build, so nothing can reach
 * this from one — and if anything ever does, the site's front door is a better
 * answer than a Mac disk image.
 */
const DOWNLOAD_URL_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: siteUrl('/download/mac'),
  win32: siteUrl('/download/windows'),
};

/** The front door, for a desktop platform that has no dedicated download route. */
const DOWNLOAD_FALLBACK_URL = links.site;

/**
 * What is waiting, if anything.
 *
 * The desktop app and a web/CLI install offer genuinely different things — a
 * restart versus a command to run — so this is a union rather than a boolean
 * with fields hanging off it.
 */
export type UpdateReadiness =
  | { kind: 'none' }
  /**
   * A desktop update on its way down (DOR-4846). `percent` is `null` before
   * the first progress report, so the card names the version without a bar.
   * `version` is `null` only from a shell too old to send it.
   */
  | { kind: 'desktop-downloading'; version: string | null; percent: number | null }
  /** A desktop download that stopped with an error; retrying fetches it again. */
  | { kind: 'desktop-download-failed'; version: string; retry: () => void }
  /** A downloaded desktop update, waiting for a restart. */
  | { kind: 'desktop-restart'; restart: () => void }
  /**
   * A desktop update that was staged and then did not install. The only action
   * left is a fresh copy from the site, which bypasses the updater entirely.
   *
   * Carries no attempt count on purpose: the card says the same thing on the
   * first failure as on the fifth, because the remedy is the same and a tally
   * is not something the reader can act on. The count lives on the wire status
   * for the main process's own logging.
   */
  | { kind: 'desktop-install-failed'; downloadFresh: () => void }
  /** A newer published version; the pill hands over the command that installs it. */
  | { kind: 'command'; latestVersion: string; dismiss: () => void };

/** Hand the person the installer for the machine they are actually on. */
function downloadFreshCopy(): void {
  const platform = typeof window === 'undefined' ? undefined : window.electronAPI?.platform;
  openExternalLink((platform && DOWNLOAD_URL_BY_PLATFORM[platform]) ?? DOWNLOAD_FALLBACK_URL);
}

/**
 * What the desktop card shows for the native updater's status.
 *
 * A download in progress takes the slot (DOR-4846). It used to be `none`, so
 * between "an update is available" and the download finishing the sidebar said
 * nothing at all, and a download that failed said nothing ever. A failed
 * install still outranks everything: restarting is the one thing that did not
 * work, so it is never offered again for that version.
 *
 * @param status - The folded native updater status.
 * @param retryingVersion - A version a retry is fetching, if one was pressed.
 * @param actions - The restart and retry the card's buttons call.
 */
function desktopReadiness(
  status: DesktopUpdateStatus | null,
  retryingVersion: string | null,
  actions: { restart: () => void; retry: () => void }
): UpdateReadiness {
  if (status?.state === 'install-failed') {
    return { kind: 'desktop-install-failed', downloadFresh: downloadFreshCopy };
  }
  if (retryingVersion) {
    return { kind: 'desktop-downloading', version: retryingVersion, percent: null };
  }
  switch (status?.state) {
    case 'downloaded':
      return { kind: 'desktop-restart', restart: actions.restart };
    case 'downloading':
      return {
        kind: 'desktop-downloading',
        version: status.version ?? null,
        percent: status.percent,
      };
    // The download starts the moment an update is found; the first progress
    // report can take a while on a slow line.
    case 'available':
      return { kind: 'desktop-downloading', version: status.version, percent: null };
    case 'error':
      // Only a stopped download names a version; a failed check stays quiet.
      return status.version
        ? { kind: 'desktop-download-failed', version: status.version, retry: actions.retry }
        : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

/**
 * Read whether there is an update to show.
 *
 * On the desktop app that is a download in progress, a failed download, a
 * download waiting for a restart, or a failed install ({@link desktopReadiness}).
 * On a web or CLI install it is a newer published version.
 */
export function useUpdateReady(): UpdateReadiness {
  const { data: config } = useConfig();
  const { isDesktop, status: desktopStatus, restart, retry, retryingVersion } = useDesktopUpdater();
  const updateConfig = useUpdateConfig();

  const version = config?.version;
  const latestVersion = config?.latestVersion ?? null;
  const dismissed = useMemo(
    () => config?.dismissedUpgradeVersions ?? [],
    [config?.dismissedUpgradeVersions]
  );

  const dismiss = useCallback(
    (dismissVersion: string) => {
      // The mutation invalidates the config query itself, so the pill
      // disappears as soon as the server confirms — no second invalidation.
      updateConfig.mutate({ ui: { dismissedUpgradeVersions: [...dismissed, dismissVersion] } });
    },
    [dismissed, updateConfig]
  );

  const isHub = config?.serverRole === 'hub';

  return useMemo(() => {
    // A hub is updated for its owner; there is no command for them to run.
    if (isHub) return { kind: 'none' };
    // Desktop reflects the native updater: `npm update -g dorkos` updates the
    // CLI, not the running `.app`.
    if (isDesktop) return desktopReadiness(desktopStatus, retryingVersion, { restart, retry });

    const ready =
      latestVersion !== null &&
      version !== undefined &&
      isNewer(latestVersion, version) &&
      !dismissed.includes(latestVersion);
    if (!ready) return { kind: 'none' };

    return { kind: 'command', latestVersion, dismiss: () => dismiss(latestVersion) };
  }, [
    isHub,
    isDesktop,
    desktopStatus,
    retryingVersion,
    restart,
    retry,
    latestVersion,
    version,
    dismissed,
    dismiss,
  ]);
}
