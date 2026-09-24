import { useState } from 'react';
import {
  Trash2,
  RefreshCw,
  FolderOpen,
  Bot,
  Shapes,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { disclosesAnything, type InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import {
  useApplyingInstallPaths,
  useInstalledPackages,
  useReviewHeldBackPackage,
} from '@/layers/entities/marketplace';
import { useShapes } from '@/layers/entities/shapes';
import { Badge, Button } from '@/layers/shared/ui';
import { humanizePackageName } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useUninstallWithToast } from '../model/use-uninstall-with-toast';
import { useApplyUpdatesWithToast } from '../model/use-apply-updates-with-toast';
import { useInstalledUpdatesView } from '../model/use-installed-updates-view';
import { useFocusRescue, type FocusRescue } from '../model/use-focus-rescue';
import {
  formatCheckVersion,
  installationPlace,
  rowUpdateState,
  type RowUpdateState,
  type StaleInstallation,
} from '../lib/installed-updates';
import { PackageTypeBadge } from './PackageTypeBadge';
import { PackageLoadingSkeleton } from './PackageLoadingSkeleton';
import { PackageEmptyState } from './PackageEmptyState';
import { PackageErrorState } from './PackageErrorState';
import { InstalledUpdatesSummary } from './InstalledUpdatesSummary';
import { InstallationUpdateStatus } from './InstallationUpdateStatus';
import { ConfirmUpdatesDialog } from './ConfirmUpdatesDialog';

// ---------------------------------------------------------------------------
// Package row sub-component
// ---------------------------------------------------------------------------

interface PackageRowProps {
  installation: InstalledPackage;
  /** True when this row is the Shape currently applied — shows an "Active" badge. */
  isActiveShape: boolean;
  isConfirmingUninstall: boolean;
  isUninstalling: boolean;
  /** Where this installation stands with respect to updates. */
  updateState: RowUpdateState;
  /** Open the Shape switcher to apply this Shape (Shapes only). */
  onApplyClick: () => void;
  /** Update this installation (offered only when an update is available). */
  onUpdateClick: () => void;
  onUninstallClick: () => void;
  /** Raise the approval card for a held-back global package (DOR-2306). */
  onReviewClick: () => void;
  /** True while that card is being raised. */
  isRaisingReview: boolean;
}

/**
 * Says a global package is held back from every session, why, and (when it can
 * be put on a card) offers to ask again, so a package never just vanishes from
 * sessions without a word (DOR-2306).
 */
function HeldBackNotice({
  heldBack,
  label,
  onReviewClick,
  isRaisingReview,
}: {
  heldBack: NonNullable<InstalledPackage['heldBack']>;
  label: string;
  onReviewClick: () => void;
  isRaisingReview: boolean;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
      <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{heldBack.note}</span>
      {heldBack.reviewable && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={onReviewClick}
          disabled={isRaisingReview}
          aria-label={`Review ${label}`}
        >
          {isRaisingReview ? 'Asking…' : 'Review'}
        </Button>
      )}
    </div>
  );
}

/**
 * The row's Update button. It exists only when there is something to install,
 * and names the version it installs, so it can never be a blind guess. While
 * this installation is being updated it stays the same element, marked
 * `aria-disabled` rather than `disabled`, so a keyboard user who pressed it
 * keeps focus on it instead of being dropped to the page.
 */
function UpdateButton({
  state,
  label,
  onClick,
  focusProps,
}: {
  state: RowUpdateState;
  /** "Reviewer" or "Reviewer on Alpha", for the accessible name. */
  label: string;
  onClick: () => void;
  /** From the row's focus rescue, so leaving does not drop focus. */
  focusProps: FocusRescue<HTMLDivElement>['controlProps'];
}) {
  if (state.kind !== 'update-available' && state.kind !== 'applying') return null;
  const applying = state.kind === 'applying';
  const { check } = state;
  const from = check && formatCheckVersion(check.installedVersion, check.installedVersionSource);
  const to = check && formatCheckVersion(check.latestVersion, check.latestVersionSource);
  return (
    <Button
      size="sm"
      variant="outline"
      aria-disabled={applying || undefined}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      onClick={applying ? undefined : onClick}
      aria-label={applying ? `Updating ${label}` : `Update ${label} from ${from} to ${to}`}
      {...focusProps}
    >
      <RefreshCw
        className={`mr-1 size-3 ${applying ? 'animate-spin motion-reduce:animate-none' : ''}`}
        aria-hidden
      />
      {applying ? 'Updating…' : `Update to ${to}`}
    </Button>
  );
}

function PackageRow({
  installation,
  isActiveShape,
  isConfirmingUninstall,
  isUninstalling,
  updateState,
  onApplyClick,
  onUpdateClick,
  onUninstallClick,
  onReviewClick,
  isRaisingReview,
}: PackageRowProps) {
  const { name, version, type, scope, installedFrom, installedAt, adapterType } = installation;
  const dependencyWarnings = installation.dependencyWarnings ?? [];
  const isShape = type === 'shape';
  // The installed record ships only a slug (no `displayName`), so humanize it
  // for the row title and every action label that names the package.
  const displayName = humanizePackageName(name);
  const formattedDate = installedAt
    ? new Date(installedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;
  const agent = installationPlace(installation);
  const label = agent ? `${displayName} on ${agent}` : displayName;
  // When Update leaves (the package is now current), focus goes to the line
  // that says so rather than to the page.
  const { targetRef: rescueTarget, controlProps: rescueProps } = useFocusRescue<HTMLDivElement>(
    updateState.kind === 'update-available' || updateState.kind === 'applying'
  );

  return (
    <div className="bg-card flex flex-col gap-3 rounded-xl border p-4 @2xl:flex-row @2xl:items-center @2xl:justify-between @2xl:gap-4 @2xl:p-6">
      {/* Left: metadata */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{displayName}</span>
          <PackageTypeBadge type={type} adapterType={adapterType} />
          {installation.heldBack && (
            <Badge
              variant="outline"
              className="border-amber-500/60 text-amber-700 dark:text-amber-300"
            >
              Held back
            </Badge>
          )}
          {isActiveShape && <Badge variant="secondary">Active</Badge>}
          <Badge variant="outline" className="font-mono">
            v{version}
          </Badge>
          {scope === 'agent-local' && (
            <span className="text-3xs rounded-full bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
              Local
            </span>
          )}
          {scope === 'override' && (
            <span className="text-3xs rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              Overrides global
            </span>
          )}
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          {agent && (
            <span className="flex items-center gap-1">
              <Bot className="size-3" aria-hidden />
              {agent}
            </span>
          )}
          {installedFrom && (
            <span className="flex items-center gap-1">
              <FolderOpen className="size-3" aria-hidden />
              {installedFrom}
            </span>
          )}
          {formattedDate && <span>Installed {formattedDate}</span>}
        </div>
        <div
          ref={rescueTarget}
          tabIndex={-1}
          data-testid="installation-update-status"
          className="focus-visible:ring-ring/50 mt-1.5 rounded-sm outline-none focus-visible:ring-2"
        >
          <InstallationUpdateStatus state={updateState} />
        </div>
        {installation.heldBack && (
          <HeldBackNotice
            heldBack={installation.heldBack}
            label={label}
            onReviewClick={onReviewClick}
            isRaisingReview={isRaisingReview}
          />
        )}
        {/* A package whose npm libraries did not install is on disk and usable
            but incomplete, and that outlives the toast the person dismissed at
            install time. The note carries its own remedy, so it is shown in
            full rather than summarised (DOR-1341). */}
        {dependencyWarnings.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {dependencyWarnings.map((warning) => (
              <p
                key={warning}
                className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                <span>{warning}</span>
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Right: actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {/* Apply lands the user on this Shape in the switcher. The active Shape
            already reads "Active"; re-apply/reset lives in the switcher, so its
            row shows no Apply — the badge is the state, no redundant button. */}
        {isShape && !isActiveShape && (
          <Button
            size="sm"
            variant="outline"
            onClick={onApplyClick}
            aria-label={`Apply ${displayName}`}
          >
            <Shapes className="mr-1 size-3" aria-hidden />
            Apply…
          </Button>
        )}

        <UpdateButton
          state={updateState}
          label={label}
          onClick={onUpdateClick}
          focusProps={rescueProps}
        />

        <Button
          size="sm"
          variant={isConfirmingUninstall ? 'destructive' : 'ghost'}
          onClick={onUninstallClick}
          disabled={isUninstalling}
          aria-label={
            isConfirmingUninstall
              ? `Confirm uninstall of ${displayName}${agent ? ` from ${agent}` : ''}`
              : `Uninstall ${displayName}${agent ? ` from ${agent}` : ''}`
          }
          className={isConfirmingUninstall ? '' : 'text-destructive hover:text-destructive'}
        >
          <Trash2 className="mr-1 size-3" aria-hidden />
          {isUninstalling ? 'Removing…' : isConfirmingUninstall ? 'Confirm' : 'Uninstall'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Milliseconds a destructive confirm is held open before auto-cancel. */
const CONFIRM_WINDOW_MS = 3_000;

// ---------------------------------------------------------------------------
// InstalledPackagesView
// ---------------------------------------------------------------------------

/**
 * "Manage Installed" surface — lists every installed marketplace package, says
 * which ones have a newer version, and updates or uninstalls each one.
 *
 * Updates: one check for every installation runs when the Marketplace opens
 * (`useInstalledUpdatesView`, shared with the tab's count). Each row says where
 * it stands, and offers "Update to vX" only when there is something to install.
 * "Update all…" opens a confirm step naming each installation, and applies
 * exactly those. A row's Update uses the same door, for that one installation.
 *
 * Uninstall requires a two-click confirmation: the first click opens a
 * 3-second confirm window; a second click within that window fires the
 * mutation with `purge: false` (data is preserved). If the window expires
 * without a second click the row resets silently.
 *
 * Renders loading, error, empty, and populated states via shared primitives
 * (`PackageLoadingSkeleton`, `PackageErrorState`, `PackageEmptyState`).
 */
export function InstalledPackagesView() {
  const { data: installed, isLoading, error, refetch } = useInstalledPackages();
  // Shapes carry an "active" flag; the installed list marks which one is applied
  // and offers Apply on the rest. Reuses the switcher's data (listShapes), no new
  // endpoint. A missing/erroring query just means no Active badge — Apply still shows.
  const { data: shapes } = useShapes();
  const activeShapeName = shapes?.find((s) => s.active)?.name;
  const openShapeSwitcherToShape = useAppStore((s) => s.openShapeSwitcherToShape);
  const uninstall = useUninstallWithToast();
  const updates = useInstalledUpdatesView();
  const applying = useApplyingInstallPaths();
  const { apply } = useApplyUpdatesWithToast();
  const review = useReviewHeldBackPackage();

  // Track which installation (by installPath — unique per scope, unlike the
  // package name) is in the confirm-uninstall window.
  const [confirmingPath, setConfirmingPath] = useState<string | null>(null);
  // What the confirm step is asking about ("Update all", or one row whose new
  // version runs something), snapshotted when the dialog opens, so a check
  // that lands meanwhile cannot change what the person confirms.
  const [confirmingUpdate, setConfirmingUpdate] = useState<StaleInstallation[] | null>(null);

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return <PackageLoadingSkeleton count={3} />;
  }

  if (error) {
    return <PackageErrorState error={error} onRetry={() => void refetch()} />;
  }

  if (!installed || installed.length === 0) {
    return (
      <PackageEmptyState
        title="No packages installed"
        description="Browse the marketplace to discover and install your first package."
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleUninstallClick(pkg: InstalledPackage) {
    if (confirmingPath === pkg.installPath) {
      // Second click within the window — fire the mutation, scoped to this
      // installation's project when it is agent-local.
      uninstall.mutate({
        name: pkg.name,
        options: { purge: false, ...(pkg.agentPath && { projectPath: pkg.agentPath }) },
        where: installationPlace(pkg) ?? undefined,
      });
      setConfirmingPath(null);
    } else {
      // First click — open the confirm window and schedule auto-cancel.
      setConfirmingPath(pkg.installPath);
      setTimeout(() => {
        setConfirmingPath((current) => (current === pkg.installPath ? null : current));
      }, CONFIRM_WINDOW_MS);
    }
  }

  function handleReview(pkg: InstalledPackage) {
    review.mutate(pkg.name, {
      onSuccess: () =>
        toast.info(`Review ${humanizePackageName(pkg.name)} on the approval card`, {
          description: 'It stays held back until you allow it there.',
        }),
      onError: (err) =>
        toast.error(`Couldn’t ask about ${humanizePackageName(pkg.name)}`, {
          description: err.message,
        }),
    });
  }

  function handleConfirmUpdate(stale: StaleInstallation[]) {
    setConfirmingUpdate(null);
    apply(stale);
  }

  /** Whether the in-flight uninstall targets this exact installation. */
  function isUninstalling(pkg: InstalledPackage): boolean {
    const variables = uninstall.variables;
    return (
      uninstall.isPending &&
      variables?.name === pkg.name &&
      (variables?.options?.projectPath ?? undefined) === (pkg.agentPath ?? undefined)
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const flags = { isChecking: updates.isChecking, applying };

  return (
    <div className="space-y-3">
      <InstalledUpdatesSummary
        summary={updates.summary}
        isChecking={updates.isChecking}
        error={updates.error}
        isApplying={applying.size > 0}
        onUpdateAll={() => setConfirmingUpdate(updates.summary.available)}
        onRecheck={updates.recheck}
      />

      <div className="@container space-y-3" role="list" aria-label="Installed packages">
        {installed.map((pkg) => {
          const updateState = rowUpdateState(pkg, updates.checks, flags);
          return (
            <div key={pkg.installPath} role="listitem">
              <PackageRow
                installation={pkg}
                isActiveShape={pkg.type === 'shape' && pkg.name === activeShapeName}
                isConfirmingUninstall={confirmingPath === pkg.installPath}
                isUninstalling={isUninstalling(pkg)}
                updateState={updateState}
                onApplyClick={() => openShapeSwitcherToShape(pkg.name)}
                onUpdateClick={() => {
                  if (updateState.kind !== 'update-available') return;
                  const item = { installation: pkg, check: updateState.check };
                  // A new version that runs anything on its own is confirmed
                  // first, with what it runs listed; one that runs nothing
                  // updates straight away (DOR-2306).
                  if (disclosesAnything(updateState.check.disclosed)) {
                    setConfirmingUpdate([item]);
                  } else {
                    apply([item]);
                  }
                }}
                onUninstallClick={() => handleUninstallClick(pkg)}
                onReviewClick={() => handleReview(pkg)}
                isRaisingReview={review.isPending && review.variables === pkg.name}
              />
            </div>
          );
        })}
      </div>

      <ConfirmUpdatesDialog
        stale={confirmingUpdate}
        onCancel={() => setConfirmingUpdate(null)}
        onConfirm={handleConfirmUpdate}
      />
    </div>
  );
}
