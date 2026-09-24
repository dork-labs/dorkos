/**
 * The confirm step before updating packages: it names every installation it
 * will reinstall (package, place, version change), and confirming updates
 * exactly those. It confirms any list, one installation included. "Update all"
 * opens it today; a row's Update still applies directly until a new version
 * has something of its own to disclose (DOR-2306), when that row will come
 * through here too, with the disclosure under its item.
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
import {
  formatCheckVersion,
  installationPlace,
  type StaleInstallation,
} from '../lib/installed-updates';

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
 * One installation in the list. A column, so what a person must know about
 * this one installation before agreeing (DOR-2306's disclosures) has a place
 * directly under its name and version.
 */
function StaleItem({ installation, check }: StaleInstallation) {
  const place = installationPlace(installation);
  const from = formatCheckVersion(check.installedVersion, check.installedVersionSource);
  const to = formatCheckVersion(check.latestVersion, check.latestVersionSource);

  return (
    <li className="bg-muted/40 space-y-1 rounded-lg px-3 py-2">
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
                  ? 'DorkOS replaces this package with its newest version, in the same place it is installed now.'
                  : 'DorkOS replaces each package below with its newest version, in the same place it is installed now.'}
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
