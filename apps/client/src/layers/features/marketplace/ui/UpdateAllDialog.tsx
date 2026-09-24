/**
 * The confirm step before "Update all": it names every installation the batch
 * will reinstall (package, place, version change), and confirming updates
 * exactly those. The list is a snapshot taken when the dialog opened, so a
 * check that lands meanwhile cannot change what the person agreed to.
 *
 * @module features/marketplace/ui/UpdateAllDialog
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

interface UpdateAllDialogProps {
  /** The installations to confirm; `null` keeps the dialog closed. */
  stale: StaleInstallation[] | null;
  /** Close without updating anything. */
  onCancel: () => void;
  /** Update exactly the listed installations. */
  onConfirm: (stale: StaleInstallation[]) => void;
}

/** "1 package" / "3 packages". */
function packages(count: number): string {
  return `${count} ${count === 1 ? 'package' : 'packages'}`;
}

/** One installation in the list: name, where it lives, and the version change. */
function StaleItem({ installation, check }: StaleInstallation) {
  const place = installationPlace(installation);
  const from = formatCheckVersion(check.installedVersion, check.installedVersionSource);
  const to = formatCheckVersion(check.latestVersion, check.latestVersionSource);

  return (
    <li className="bg-muted/40 flex items-start justify-between gap-4 rounded-lg px-3 py-2">
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
    </li>
  );
}

/**
 * Confirm "Update all". Opens when `stale` is set and lists each installation;
 * a desktop dialog, a drawer on phones.
 */
export function UpdateAllDialog({ stale, onCancel, onConfirm }: UpdateAllDialogProps) {
  const count = stale?.length ?? 0;

  return (
    <ResponsiveDialog open={stale !== null} onOpenChange={(open) => !open && onCancel()}>
      <ResponsiveDialogContent className="max-h-[85vh] !min-h-0 sm:max-w-lg">
        {stale && (
          <>
            <ResponsiveDialogHeader className="shrink-0">
              <ResponsiveDialogTitle>Update {packages(count)}?</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                DorkOS replaces each package below with its newest version, in the same place it is
                installed now.
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
              <Button onClick={() => onConfirm(stale)}>Update {packages(count)}</Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
