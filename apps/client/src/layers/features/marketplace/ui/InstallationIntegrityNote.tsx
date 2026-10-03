/**
 * What an installation's integrity means for the person, on its row
 * (DOR-2197): files changed since install, as a disclosure that opens to the
 * paths, or an install an older DorkOS made without recording its files, and
 * whether "Check files" can help. Files an update kept because nothing proved
 * whose they were get a note of their own (DOR-2322). A clean, linked or
 * unverified installation adds nothing.
 *
 * Only the icon carries colour. The text stays muted, so a real failure on the
 * row (a red "Couldn't update") remains the one urgent line.
 *
 * @module features/marketplace/ui/InstallationIntegrityNote
 */
import { ChevronRight, FileWarning, History } from 'lucide-react';
import type { InstallIntegrity } from '@dorkos/shared/marketplace-schemas';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

/** A modified installation's integrity. */
export type ModifiedIntegrity = Extract<InstallIntegrity, { status: 'modified' }>;

/** What the note beside the "Check files" button says it does. */
export const CHECK_FILES_EXPLANATION = 'Check files so updates keep your edits.';

/** "the file you edited" / "the 3 files you edited". */
function theFiles(count: number, verb: string): string {
  return count === 1 ? `the file you ${verb}` : `the ${count} files you ${verb}`;
}

/**
 * What an update does to the files a person changed, one short sentence per
 * kind of change, or an empty list when nothing changed that an update
 * touches. An update replaces edited files (keeping the person's copies),
 * keeps files they added, and puts back files they removed.
 *
 * One sentence per kind, never one joined sentence: each renders as its own
 * paragraph, so each stays inside the 15-word cap (`writing-app-copy`).
 *
 * @param integrity - A modified installation's integrity.
 */
export function updateConsequences(integrity: ModifiedIntegrity): string[] {
  return [
    integrity.changed.length > 0 &&
      `Updating replaces ${theFiles(integrity.changed.length, 'edited')} and keeps your copies beside them.`,
    integrity.added.length > 0 &&
      (integrity.added.length === 1
        ? 'The file you added stays.'
        : `The ${integrity.added.length} files you added stay.`),
    integrity.missing.length > 0 &&
      (integrity.missing.length === 1
        ? 'The file you removed comes back.'
        : `The ${integrity.missing.length} files you removed come back.`),
  ].filter((p): p is string => typeof p === 'string');
}

/**
 * The one line a row keeps visible about what an update does, on every screen
 * size: a row's Update button can apply an update with no confirm step, so the
 * warning cannot wait inside the disclosure. The most consequential kind of
 * change wins; the disclosure holds the full list.
 *
 * @param integrity - A modified installation's integrity.
 */
function updateHeadline(integrity: ModifiedIntegrity): string | undefined {
  if (integrity.changed.length > 0) return 'Updating replaces your edits; copies are kept.';
  if (integrity.missing.length > 0) return 'Updating puts back files you removed.';
  if (integrity.added.length > 0) return 'Updating keeps the files you added.';
  return undefined;
}

/** "3 files changed since install (2 edited, 1 added)". */
function changeSummary(integrity: ModifiedIntegrity): string {
  const kinds = [
    [integrity.changed.length, 'edited'],
    [integrity.added.length, 'added'],
    [integrity.missing.length, 'removed'],
  ] as const;
  const present = kinds.filter(([count]) => count > 0);
  const total = present.reduce((sum, [count]) => sum + count, 0);
  const more = integrity.truncated ? '+' : '';
  const head = `${total}${more} ${total === 1 ? 'file' : 'files'} changed since install`;
  return present.length > 1
    ? `${head} (${present.map(([count, kind]) => `${count} ${kind}`).join(', ')})`
    : head;
}

/** Whether the integrity describes an older install that has no real record yet (none, or only a guessed one). */
function isOlderInstall(
  integrity: InstallIntegrity | undefined
): integrity is Extract<InstallIntegrity, { status: 'unknown' }> {
  return (
    integrity?.status === 'unknown' &&
    (integrity.reason === 'no-record' || integrity.reason === 'inferred')
  );
}

/**
 * Whether "Check files" can help this installation: an older install with an
 * exact version to fetch, not already found to differ, or files an update kept
 * unproven that the earlier version can sort.
 */
export function canCheckFiles(integrity: InstallIntegrity | undefined): boolean {
  const check = isOlderInstall(integrity)
    ? integrity.check
    : integrity?.status === 'clean' || integrity?.status === 'modified'
      ? integrity.unproven?.check
      : undefined;
  if (!check || check.source === 'local') return false;
  const last = check.last?.outcome;
  return last !== 'mismatch' && last !== 'no-source';
}

/** The kept files an installation's integrity lists (DOR-2322). */
type Unproven = NonNullable<Extract<InstallIntegrity, { status: 'clean' }>['unproven']>;

/**
 * Whether "Keep these as mine" is offered for these kept files (DOR-2341):
 * only where Check files cannot sort them, because there is no earlier
 * version (installed from a folder) or its last try could not download it.
 * Otherwise Check files comes first, since it sets the leftovers aside.
 *
 * @param unproven - The kept files, as the row lists them.
 */
export function canKeepFiles(unproven: Pick<Unproven, 'check'>): boolean {
  return unproven.check.source === 'local' || unproven.check.last?.outcome === 'fetch-failed';
}

/**
 * One group of paths in the opened disclosure, or nothing when it is empty.
 *
 * @param props.title - The group's heading, also the list's accessible name.
 * @param props.paths - The paths, in order.
 */
export function PathGroup({ title, paths }: { title: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div>
      <p className="text-3xs font-medium tracking-wide uppercase">{title}</p>
      <ul aria-label={title} className="mt-0.5 space-y-0.5">
        {paths.map((p) => (
          <li key={p} className="font-mono text-xs [overflow-wrap:anywhere]">
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The note for files an update kept because nothing proved whose they were
 * (DOR-2322): a count that opens to the paths and says what happened, whether
 * Check files can sort them, and a way to keep them as the person's
 * (DOR-2341).
 */
function UnprovenNote({
  unproven,
  label,
  onKeepFiles,
}: {
  unproven: NonNullable<Extract<InstallIntegrity, { status: 'clean' }>['unproven']>;
  label?: string;
  onKeepFiles?: () => void;
}) {
  const count = unproven.files.length;
  const running = unproven.running;
  const runs = running.length > 0;
  const local = unproven.check.source === 'local';
  const inert = unproven.files.filter((p) => !running.includes(p));
  return (
    <details
      data-testid="installation-integrity-unproven"
      data-runs={runs ? 'true' : 'false'}
      className="group/kept mt-1 text-xs"
    >
      <summary
        className={cn(
          'focus-ring flex cursor-pointer list-none items-start gap-1 rounded-sm select-none [&::-webkit-details-marker]:hidden',
          // A kept file that still runs is the one thing here worth a glance:
          // it carries the amber the icon alone carries otherwise.
          runs
            ? 'text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <History
          className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <span>
          Kept {count} {count === 1 ? 'file' : 'files'} an update couldn’t sort.
          {runs &&
            ` ${running.length} of ${count === 1 ? 'it' : 'them'} still ${running.length === 1 ? 'runs' : 'run'}.`}
        </span>
        <ChevronRight
          className="mt-0.5 size-3 shrink-0 transition-transform duration-200 group-open/kept:rotate-90"
          aria-hidden
        />
      </summary>
      <div className="text-muted-foreground mt-1.5 space-y-1.5 pl-4">
        <p>Unclear if these are yours or leftovers, so DorkOS kept them.</p>
        <p>
          {local
            ? 'Keep them as yours, or delete any you don’t need.'
            : 'Check files sets aside the leftovers and keeps yours.'}
        </p>
        {unproven.check.last && <p>{unproven.check.last.message}</p>}
        <PathGroup title="Still runs" paths={running} />
        <PathGroup title="Kept" paths={inert} />
        {onKeepFiles && canKeepFiles(unproven) && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={onKeepFiles}
            aria-label={`Keep the files ${label ?? 'this package'} kept as mine`}
          >
            Keep these as mine
          </Button>
        )}
      </div>
    </details>
  );
}

/**
 * The note under a row's metadata, or nothing.
 *
 * @param props.integrity - The installation's integrity, when verification has answered.
 * @param props.updateAvailable - Whether this row offers an update, so the note says what it would do.
 * @param props.label - The row's name ("Flow on Alpha"), for the Try again link's accessible name.
 * @param props.onCheckFiles - Check this installation's files again (after a mismatch).
 * @param props.isCheckingFiles - A check of this installation is running.
 * @param props.onKeepFiles - Keep the files an update kept as the person's (DOR-2341).
 */
export function InstallationIntegrityNote(props: {
  integrity?: InstallIntegrity;
  updateAvailable: boolean;
  label?: string;
  onCheckFiles?: () => void;
  isCheckingFiles?: boolean;
  onKeepFiles?: () => void;
}) {
  const { integrity } = props;
  const unproven =
    integrity?.status === 'clean' || integrity?.status === 'modified'
      ? integrity.unproven
      : undefined;
  if (!unproven) return <IntegrityNote {...props} />;
  return (
    <>
      <IntegrityNote {...props} />
      <UnprovenNote unproven={unproven} label={props.label} onKeepFiles={props.onKeepFiles} />
    </>
  );
}

/** The main note: files changed since install, or an older install. */
function IntegrityNote({
  integrity,
  updateAvailable,
  label,
  onCheckFiles,
  isCheckingFiles = false,
}: {
  integrity?: InstallIntegrity;
  updateAvailable: boolean;
  label?: string;
  onCheckFiles?: () => void;
  isCheckingFiles?: boolean;
}) {
  if (integrity?.status === 'modified') {
    const consequences = updateAvailable ? updateConsequences(integrity) : [];
    const headline = updateAvailable ? updateHeadline(integrity) : undefined;
    return (
      <details data-testid="installation-integrity" className="group/files mt-1 text-xs">
        <summary className="text-muted-foreground hover:text-foreground focus-ring flex cursor-pointer list-none items-start gap-1 rounded-sm select-none [&::-webkit-details-marker]:hidden">
          <FileWarning className="text-status-warning-dot mt-0.5 size-3 shrink-0" aria-hidden />
          {/* The summary, and when an update is on offer one short line on
              what it does, visible on every screen; the per-kind detail waits
              inside the disclosure. */}
          <span className="flex flex-col">
            <span>{changeSummary(integrity)}.</span>
            {headline && <span data-testid="installation-integrity-update">{headline}</span>}
          </span>
          <ChevronRight
            className="mt-0.5 size-3 shrink-0 transition-transform duration-200 group-open/files:rotate-90"
            aria-hidden
          />
        </summary>
        <div className="text-muted-foreground mt-1.5 space-y-1.5 pl-4">
          {consequences.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
          <PathGroup title="Edited" paths={integrity.changed} />
          <PathGroup title="Added" paths={integrity.added} />
          <PathGroup title="Removed" paths={integrity.missing} />
          {integrity.truncated && <p>Showing the first 50 of each.</p>}
        </div>
      </details>
    );
  }
  if (isOlderInstall(integrity)) {
    const local = integrity.check?.source === 'local';
    const last = integrity.check?.last;
    const text = local
      ? 'Installed from a folder by an older DorkOS. Reinstall so updates keep your edits.'
      : last
        ? last.message
        : `Installed by an older DorkOS. ${CHECK_FILES_EXPLANATION}`;
    // After the files were found to differ, a small Try again instead of the
    // full button: the person may have put their edits back since.
    const retry = !local && last?.outcome === 'mismatch' && onCheckFiles;
    return (
      <p
        data-testid="installation-integrity"
        className="text-muted-foreground mt-1 flex items-start gap-1 text-xs"
      >
        <History className="text-status-warning-dot mt-0.5 size-3 shrink-0" aria-hidden />
        <span>
          {text}
          {retry && (
            <>
              {' '}
              <button
                type="button"
                onClick={onCheckFiles}
                disabled={isCheckingFiles}
                aria-label={`Check the files of ${label ?? 'this package'} again`}
                className="text-foreground focus-ring rounded-sm underline underline-offset-2 disabled:opacity-50"
              >
                {isCheckingFiles ? 'Checking…' : 'Try again'}
              </button>
            </>
          )}
        </span>
      </p>
    );
  }
  return null;
}
