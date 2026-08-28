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
  darwin: 'https://dorkos.ai/download/mac',
  win32: 'https://dorkos.ai/download/windows',
};

/** The front door, for a desktop platform that has no dedicated download route. */
const DOWNLOAD_FALLBACK_URL = 'https://dorkos.ai';

/**
 * What is waiting, if anything.
 *
 * The desktop app and a web/CLI install offer genuinely different things — a
 * restart versus a command to run — so this is a union rather than a boolean
 * with fields hanging off it.
 */
export type UpdateReadiness =
  | { kind: 'none' }
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
 * Read whether an update is ready.
 *
 * A download still in progress is deliberately `none`: it is not something
 * anybody can act on, and the slot should be offering whatever else it has. A
 * failed install is the opposite — it is the one update state a person MUST be
 * told about, so it qualifies for the slot exactly as a waiting restart does.
 */
export function useUpdateReady(): UpdateReadiness {
  const { data: config } = useConfig();
  const { isDesktop, status: desktopStatus, restart } = useDesktopUpdater();
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

  return useMemo(() => {
    // Desktop reflects the native updater: `npm update -g dorkos` updates the
    // CLI, not the running `.app`.
    if (isDesktop) {
      // A restart is never re-offered for an update that already refused to
      // install — restarting is precisely the thing that did not work.
      if (desktopStatus?.state === 'install-failed') {
        return { kind: 'desktop-install-failed', downloadFresh: downloadFreshCopy };
      }
      if (desktopStatus?.state !== 'downloaded') return { kind: 'none' };
      return { kind: 'desktop-restart', restart };
    }

    const ready =
      latestVersion !== null &&
      version !== undefined &&
      isNewer(latestVersion, version) &&
      !dismissed.includes(latestVersion);
    if (!ready) return { kind: 'none' };

    return { kind: 'command', latestVersion, dismiss: () => dismiss(latestVersion) };
  }, [isDesktop, desktopStatus, restart, latestVersion, version, dismissed, dismiss]);
}
