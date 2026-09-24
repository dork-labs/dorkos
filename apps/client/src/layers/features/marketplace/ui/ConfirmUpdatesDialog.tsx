/**
 * The confirm step before updating packages: it names every installation it
 * will reinstall (package, place, version change) and, under each one,
 * everything its new version runs on its own: each command and when it runs,
 * each server or program and where it starts, each skill allowed to use tools
 * without asking, each scheduled job. Confirming updates exactly those, held
 * to what is listed: the apply sends each disclosure back, and the server
 * refuses a version that now runs anything else (DOR-2306).
 *
 * It confirms any list, one installation included. "Update all" opens it, and
 * so does a row's Update whenever the new version runs something; a new
 * version that runs nothing updates straight from its row.
 *
 * The list is a snapshot taken when the dialog opened, so a check that lands
 * meanwhile cannot change what the person agreed to.
 *
 * @module features/marketplace/ui/ConfirmUpdatesDialog
 */
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { humanizePackageName } from '@/layers/shared/lib';
import { formatDisclosedEffects } from '../lib/format-permissions';
import {
  formatCheckVersion,
  installationPlace,
  type StaleInstallation,
} from '../lib/installed-updates';
import { PermissionItem } from './PermissionPreviewSection';

interface ConfirmUpdatesDialogProps {
  /** The installations to confirm; `null` keeps the dialog closed. */
  stale: StaleInstallation[] | null;
  /** Close without updating anything. */
  onCancel: () => void;
  /** Update exactly the listed installations. */
  onConfirm: (stale: StaleInstallation[]) => void;
}

/** What the title and the confirm button call the list: one package by name, else a count. */
function subjectOf(stale: StaleInstallation[]): string {
  if (stale.length !== 1) return `${stale.length} packages`;
  const [{ installation }] = stale as [StaleInstallation];
  const place = installationPlace(installation);
  const name = humanizePackageName(installation.name);
  return place ? `${name} on ${place}` : name;
}

/**
 * What one installation's new version runs, as rows. Nothing to list is said
 * in one line, so "runs nothing" is never mistaken for "not checked".
 */
function Disclosure({ check }: StaleInstallation) {
  const rows = check.disclosed
    ? formatDisclosedEffects(check.disclosed, check.scope === 'global' ? 'global' : 'project')
    : [];
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">The new version runs nothing on its own.</p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs">
        The new version runs {rows.length === 1 ? 'this' : `these ${rows.length}`} on its own:
      </p>
      <ul aria-label="What the new version runs" className="space-y-2">
        {rows.map((row, index) => (
          <PermissionItem key={index} item={row} />
        ))}
      </ul>
    </div>
  );
}

/**
 * One installation in the list: its name, place and version change, and under
 * them what its new version runs.
 */
function StaleItem(item: StaleInstallation) {
  const { installation, check } = item;
  const place = installationPlace(installation);
  const from = formatCheckVersion(check.installedVersion, check.installedVersionSource);
  const to = formatCheckVersion(check.latestVersion, check.latestVersionSource);

  return (
    <li className="bg-muted/40 space-y-2 rounded-lg px-3 py-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{humanizePackageName(installation.name)}</div>
          <div className="text-muted-foreground text-xs">{place ?? 'All agents'}</div>
          {place && installation.agentPath && (
            <div className="text-muted-foreground text-2xs truncate font-mono">
              {installation.agentPath}
            </div>
          )}
        </div>
        <div className="shrink-0 font-mono text-xs">
          {from} <span aria-hidden>→</span>
          <span className="sr-only">to</span> {to}
        </div>
      </div>
      <Disclosure {...item} />
    </li>
  );
}

/**
 * Confirm updating a list of installations. Opens when `stale` is set; a
 * desktop dialog, a drawer on phones.
 */
export function ConfirmUpdatesDialog({ stale, onCancel, onConfirm }: ConfirmUpdatesDialogProps) {
  return (
    <ResponsiveDialog open={stale !== null} onOpenChange={(open) => !open && onCancel()}>
      <ResponsiveDialogContent className="max-h-[85vh] !min-h-0 sm:max-w-lg">
        {stale && (
          <>
            <ResponsiveDialogHeader className="shrink-0">
              <ResponsiveDialogTitle>Update {subjectOf(stale)}?</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {stale.length === 1
                  ? 'DorkOS replaces this package with its newest version, in the same place it is installed now. Check what the new version runs before you update.'
                  : 'DorkOS replaces each package below with its newest version, in the same place it is installed now. Check what each new version runs before you update.'}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>

            <ResponsiveDialogBody>
              <ul aria-label="Packages to update" className="space-y-2">
                {stale.map((item) => (
                  <StaleItem key={item.check.installPath} {...item} />
                ))}
              </ul>
            </ResponsiveDialogBody>

            <ResponsiveDialogFooter className="shrink-0">
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button onClick={() => onConfirm(stale)}>Update {subjectOf(stale)}</Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
