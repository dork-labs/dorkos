/**
 * The confirm step for "Keep these as mine" (DOR-2341): the files an update
 * kept because it couldn't tell whether they were the person's, listed with
 * the ones that still run apart, and a plain statement that keeping them moves
 * and deletes nothing.
 *
 * For a global package held back from sessions, it also shows everything the
 * package runs, and confirming approves what it discloses now, like a Review:
 * the confirm sends back exactly what was shown, and the
 * server records it only if the package is still that. Until what it runs has
 * loaded, the confirm waits, so a person never approves something they
 * weren't shown.
 *
 * @module features/marketplace/ui/KeepFilesDialog
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
import type {
  InstallIntegrity,
  InstalledPackage,
  KeepFilesOptions,
} from '@dorkos/shared/marketplace-schemas';
import { humanizePackageName } from '@/layers/shared/lib';
import { useHeldBackPackages } from '@/layers/entities/marketplace';
import { formatDisclosedEffects } from '../lib/format-permissions';
import { PermissionItem } from './PermissionPreviewSection';
import { PathGroup } from './InstallationIntegrityNote';

/** The kept files one installation's integrity lists. */
export type UnprovenFiles = NonNullable<Extract<InstallIntegrity, { status: 'clean' }>['unproven']>;

interface KeepFilesDialogProps {
  /** The installation whose kept files to keep; `null` keeps the dialog closed. */
  installation: InstalledPackage | null;
  /** Its kept files, as the row shows them. */
  unproven: UnprovenFiles | undefined;
  /** Close without changing anything. */
  onCancel: () => void;
  /** Keep them, with exactly what was shown. */
  onConfirm: (options: KeepFilesOptions) => void;
}

/** Whether keeping this installation's files also decides whether it runs. */
function decidesActivation(installation: InstalledPackage | null): boolean {
  return (
    installation !== null &&
    installation.heldBack !== undefined &&
    (installation.scope === undefined || installation.scope === 'global')
  );
}

/**
 * Confirm keeping an installation's kept files as the person's. A desktop
 * dialog, a drawer on phones.
 */
export function KeepFilesDialog({
  installation,
  unproven,
  onCancel,
  onConfirm,
}: KeepFilesDialogProps) {
  const activation = decidesActivation(installation);
  const heldBack = useHeldBackPackages(activation);
  const held = activation ? heldBack.data?.find((p) => p.name === installation?.name) : undefined;
  const review =
    held?.effects && held.bindsTo ? { effects: held.effects, bindsTo: held.bindsTo } : undefined;
  const waiting = activation && heldBack.isPending;
  const open = installation !== null && unproven !== undefined;
  const name = installation ? humanizePackageName(installation.name) : '';
  const running = unproven?.running ?? [];
  const inert = unproven?.files.filter((p) => !running.includes(p)) ?? [];
  const rows = review ? formatDisclosedEffects(review.effects, 'global') : [];

  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <ResponsiveDialogContent className="max-h-[85vh] !min-h-0 sm:max-w-lg">
        {open && installation && unproven && (
          <>
            <ResponsiveDialogHeader className="shrink-0 text-left">
              <ResponsiveDialogTitle className="text-left">
                Keep the files {name} kept as yours?
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription className="text-left">
                An update couldn’t tell whether these were yours or left over from the version you
                had,{' '}
                {unproven.check.source === 'local'
                  ? 'and there’s no earlier version to sort them with.'
                  : 'and DorkOS couldn’t download the version you had to sort them with.'}{' '}
                Keeping them makes them yours: updates keep them. Nothing is moved or deleted.
                {running.length > 0 && ' They run as your own files from now on.'}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>

            <ResponsiveDialogBody className="space-y-3 text-xs">
              <PathGroup title="Still runs" paths={running} />
              <PathGroup title="Kept" paths={inert} />
              {activation && (
                <div data-testid="keep-files-activation" className="space-y-1.5">
                  {waiting ? (
                    <p className="text-muted-foreground">Reading what {name} runs…</p>
                  ) : review ? (
                    <>
                      <p className="text-foreground font-medium">
                        {name} is held back from sessions. Keeping also lets it run, in every
                        session, as it is now:
                      </p>
                      <ul aria-label={`What ${name} runs`} className="space-y-1.5">
                        {rows.map((row, index) => (
                          <PermissionItem key={index} item={row} />
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      {name} is held back from sessions and still waits for your Review after this.
                    </p>
                  )}
                </div>
              )}
            </ResponsiveDialogBody>

            <ResponsiveDialogFooter className="shrink-0">
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                disabled={waiting}
                onClick={() =>
                  onConfirm({
                    installRoot: installation.installPath,
                    keepKey: unproven.keepKey,
                    ...(installation.agentPath && { projectPath: installation.agentPath }),
                    ...(review && { review }),
                  })
                }
              >
                {review ? 'Keep them and let it run' : 'Keep them as mine'}
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
