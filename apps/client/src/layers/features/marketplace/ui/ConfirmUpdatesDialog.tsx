/**
 * The confirm step before updating packages: it names every installation it
 * will reinstall (package, place, version change) and, under each one,
 * everything its new version runs on its own: each command and when it runs,
 * each server or program and where it starts, each skill allowed to use tools
 * without asking, each scheduled job. What is new or changed against the
 * installed version leads, marked; what is unchanged is folded behind a count.
 * Confirming updates exactly those, held to the whole list: the apply sends
 * each disclosure and the files' hash back, and the server refuses a version
 * that now runs or ships anything else (DOR-2306).
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
import { ChevronRight } from 'lucide-react';
import {
  Badge,
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
import { formatDisclosureChanges, type DisclosureRow } from '../lib/format-permissions';
import {
  formatCheckVersion,
  installationPlace,
  type StaleInstallation,
} from '../lib/installed-updates';
import { PermissionItem, withBreakPoints } from './PermissionPreviewSection';

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

/** Every row one installation's new version runs, marked against what is installed. */
function rowsOf({ check }: StaleInstallation): DisclosureRow[] {
  if (!check.disclosed) return [];
  return formatDisclosureChanges(
    check.disclosed,
    check.installedDisclosed,
    check.scope === 'global' ? 'global' : 'project'
  );
}

/**
 * One line over the list: how many of the new versions run things on their
 * own, and how many add or change something, so a person knows where to look.
 *
 * @param stale - The installations being confirmed.
 * @returns The sentence, e.g. "2 of 3 run things on their own · 1 adds something new".
 */
export function summarizeUpdateDisclosures(stale: readonly StaleInstallation[]): string {
  const rows = stale.map(rowsOf);
  const running = rows.filter((r) => r.length > 0).length;
  const adding = rows.filter((r) =>
    r.some((row) => row.change === 'new' || row.change === 'changed')
  ).length;
  const runs =
    stale.length === 1
      ? running === 1
        ? 'The new version runs things on its own'
        : 'The new version runs nothing on its own'
      : `${running} of ${stale.length} run things on their own`;
  if (adding === 0) return runs;
  const adds =
    stale.length === 1
      ? 'it adds or changes something'
      : `${adding} ${adding === 1 ? 'adds' : 'add'} or ${adding === 1 ? 'changes' : 'change'} something`;
  return `${runs} · ${adds}`;
}

/** The mark on a new or changed row. */
function ChangeBadge({ change }: { change: DisclosureRow['change'] }) {
  if (change !== 'new' && change !== 'changed') return null;
  return (
    <Badge
      variant="outline"
      className="text-3xs shrink-0 border-amber-500/60 text-amber-700 dark:text-amber-300"
    >
      {change === 'new' ? 'New' : 'Changed'}
    </Badge>
  );
}

/**
 * A row with its mark beside it. A changed row also shows the command the
 * installed version runs in its place, muted and labelled, so the person
 * compares the two values instead of taking "Changed" on trust.
 */
function MarkedRow({ row, change, previous }: DisclosureRow) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <ul>
          <PermissionItem item={row} />
        </ul>
        {previous && (
          <div className="mt-1 pl-6 opacity-70">
            <p className="text-muted-foreground text-3xs mb-0.5 font-medium tracking-wide uppercase">
              Installed now
            </p>
            <ul aria-label="What the installed version runs instead">
              {/* Just the old command: its description repeats the new row's. */}
              <PermissionItem item={{ ...previous, description: undefined, details: undefined }} />
            </ul>
          </div>
        )}
      </div>
      <ChangeBadge change={change} />
    </div>
  );
}

/**
 * What one installation's new version runs. New and changed rows lead;
 * unchanged ones fold behind a count, still part of what is approved. Nothing
 * to list is said in one line, so "runs nothing" is never mistaken for "not
 * checked".
 */
function Disclosure(item: StaleInstallation) {
  const rows = rowsOf(item);
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">The new version runs nothing on its own.</p>
    );
  }
  const lead = rows.filter((r) => r.change !== 'unchanged');
  const unchanged = rows.filter((r) => r.change === 'unchanged');
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs">
        The new version runs {rows.length === 1 ? 'this' : `these ${rows.length}`} on its own:
      </p>
      <div role="list" aria-label="What the new version runs" className="space-y-2">
        {lead.map((row, index) => (
          <div role="listitem" key={`lead-${index}`}>
            <MarkedRow {...row} />
          </div>
        ))}
        {unchanged.length > 0 && (
          <details className="group/unchanged" role="listitem">
            <summary className="text-muted-foreground hover:text-foreground focus-ring inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs select-none [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 shrink-0 transition-transform duration-200 group-open/unchanged:rotate-90" />
              {unchanged.length} unchanged
            </summary>
            <div className="mt-2 space-y-2">
              {unchanged.map((row, index) => (
                <MarkedRow key={`same-${index}`} {...row} />
              ))}
            </div>
          </details>
        )}
      </div>
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
            <div className="text-muted-foreground text-2xs font-mono [overflow-wrap:anywhere]">
              {withBreakPoints(installation.agentPath)}
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
      <ResponsiveDialogContent className="max-h-[85vh] !min-h-0 sm:max-w-xl">
        {stale && (
          <>
            <ResponsiveDialogHeader className="shrink-0 text-left">
              <ResponsiveDialogTitle className="text-left">
                Update {subjectOf(stale)}?
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription className="text-left">
                {stale.length === 1
                  ? 'DorkOS replaces this package with its newest version, in the same place it is installed now. Check what the new version runs before you update.'
                  : 'DorkOS replaces each package below with its newest version, in the same place it is installed now. Check what each new version runs before you update.'}
              </ResponsiveDialogDescription>
              <p
                className="text-foreground text-left text-xs font-medium"
                data-testid="update-disclosure-summary"
              >
                {summarizeUpdateDisclosures(stale)}
              </p>
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
