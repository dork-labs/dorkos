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
import { isNewer } from '@/layers/shared/lib';
import { useDesktopUpdater } from '@/layers/features/session-list';

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
  /** A newer published version; the pill hands over the command that installs it. */
  | { kind: 'command'; latestVersion: string; dismiss: () => void };

/**
 * Read whether an update is ready.
 *
 * A download still in progress is deliberately `none`: it is not something
 * anybody can act on, and the slot should be offering whatever else it has.
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
  }, [isDesktop, desktopStatus?.state, restart, latestVersion, version, dismissed, dismiss]);
}
