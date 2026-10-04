/**
 * The dev-link parts of an installed package (DOR-2696): the "Dev link: <path>"
 * line, the status under it ("Reloaded 4s ago", a build error, a missing
 * folder), and the switches it offers instead of Update and Uninstall. Shared
 * by the Installed row and the package sheet, so both say the same thing.
 *
 * @module features/marketplace/ui/DevLinkRow
 */
import { AlertTriangle, ArrowDownToLine, RotateCcw, Unlink } from 'lucide-react';
import type { AggregatedPackage, InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import { Button, DevLinkPath, MoreDetails } from '@/layers/shared/ui';
import { useNow } from '@/layers/shared/model';
import { devLinkKey, useDevLinkReloadStore, useDevLinks } from '@/layers/entities/marketplace';
import {
  devLinkIdentityOf,
  devLinkRowStatus,
  findDevLinkStatus,
  formatReloadedAgo,
  type DevLinkRowStatus,
} from '../lib/dev-links';

/**
 * Where a dev-linked installation stands now: the newest reload this app heard
 * about, the listing's last reload, and whether the link is still in force.
 *
 * @param installation - An installed row with `devLink` set.
 */
export function useDevLinkRowStatus(installation: InstalledPackage): DevLinkRowStatus | null {
  const { data: listing } = useDevLinks();
  const entry = findDevLinkStatus(listing?.links, installation);
  const key = devLinkKey(devLinkIdentityOf(installation, entry));
  const reload = useDevLinkReloadStore((s) => s.latest[key]);
  if (!installation.devLink) return null;
  return devLinkRowStatus(installation.devLink, reload, entry);
}

/** The status sentence for a dev link, with a Details toggle for a failed reload. */
function DevLinkStatusText({ status }: { status: DevLinkRowStatus }) {
  switch (status.kind) {
    case 'reloaded':
      return <ReloadedAgo at={status.at} />;
    case 'watching':
      return <p className="text-muted-foreground text-xs">Watching for edits.</p>;
    case 'reload-failed':
      return (
        <div className="text-status-warning-fg space-y-1 text-xs">
          <p className="flex items-start gap-1">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="[overflow-wrap:anywhere]">{status.headline}</span>
          </p>
          <MoreDetails label="Details" openLabel="Hide details" className="ml-4">
            {status.details.map((detail, index) => (
              <p key={`${index}-${detail}`} className="font-mono text-xs [overflow-wrap:anywhere]">
                {detail}
              </p>
            ))}
          </MoreDetails>
        </div>
      );
    case 'folder-missing':
      return <Warning>Folder missing. Restore it or unlink.</Warning>;
    case 'link-missing':
      return <Warning>Its link is gone. Unlink to finish.</Warning>;
    case 'link-replaced':
      return <Warning>Something else is in its place. Unlink to finish.</Warning>;
  }
}

/**
 * "Reloaded 4s ago", ticking each second: a person saves and looks for the
 * change, so seconds matter. The exact time shows on hover.
 */
function ReloadedAgo({ at }: { at: string }) {
  const now = useNow(1_000);
  return (
    <time
      dateTime={at}
      title={new Date(at).toLocaleString()}
      className="text-muted-foreground text-xs"
    >
      {formatReloadedAgo(at, now)}
    </time>
  );
}

/** A dev link that is not in force, said with a warning icon. */
function Warning({ children }: { children: string }) {
  return (
    <p className="text-status-warning-fg flex items-start gap-1 text-xs">
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * The path line and status for a dev-linked installation. Renders nothing for
 * an installation that is not a dev link.
 */
export function DevLinkDetails({ installation }: { installation: InstalledPackage }) {
  const status = useDevLinkRowStatus(installation);
  if (!installation.devLink || !status) return null;
  return (
    <div className="mt-1.5 space-y-1" data-testid="dev-link-details">
      <DevLinkPath path={installation.devLink.path} />
      <div role="status" aria-live="polite" data-testid="dev-link-status">
        <DevLinkStatusText status={status} />
      </div>
    </div>
  );
}

/** Props for {@link DevLinkActionButtons}. */
export interface DevLinkActionButtonsProps {
  /** The dev-linked installation. */
  installation: InstalledPackage;
  /** The package as a marketplace lists it, when one does. */
  published?: AggregatedPackage;
  /** "Reviewer" or "Reviewer on Alpha", for accessible names. */
  label: string;
  /** Open the unlink dialog. */
  onUnlink: () => void;
  /** Unlink, then open the install dialog for the published package. */
  onInstallPublished: (published: AggregatedPackage) => void;
  /** Disable every switch (another change is in flight). */
  disabled?: boolean;
}

/**
 * The switches a dev-linked installation offers. With an installed copy set
 * aside, "Use installed copy" is the one switch (unlinking is exactly that).
 * Without one, "Install published version" when a marketplace lists the
 * package, and "Unlink".
 */
export function DevLinkActionButtons({
  installation,
  published,
  label,
  onUnlink,
  onInstallPublished,
  disabled,
}: DevLinkActionButtonsProps) {
  if (!installation.devLink) return null;
  if (installation.devLink.parked) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={onUnlink}
        disabled={disabled}
        aria-label={`Use the installed copy of ${label}`}
      >
        <RotateCcw className="mr-1 size-3" aria-hidden />
        Use installed copy
      </Button>
    );
  }
  return (
    <>
      {published && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onInstallPublished(published)}
          disabled={disabled}
          aria-label={`Install the published version of ${label}`}
        >
          <ArrowDownToLine className="mr-1 size-3" aria-hidden />
          Install published version
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={onUnlink}
        disabled={disabled}
        aria-label={`Unlink ${label}`}
      >
        <Unlink className="mr-1 size-3" aria-hidden />
        Unlink
      </Button>
    </>
  );
}
