/** Historical save evidence never claims the current draft or an agent delivery was saved. */
import type { ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/layers/shared/ui';
import type { useFileSaveRecovery } from '../../model/file-save/use-file-save-recovery';

type Recovery = ReturnType<typeof useFileSaveRecovery>;

/**
 * The one sentence a failed check leaves, with "Check again" beside it. A 404
 * (`refused`) is the server saying this file is never saved from here; anything
 * else is a fault worth retrying.
 */
const FAILED_CHECK = {
  unavailable: 'Couldn’t check previous saves, so editing is off.',
  refused: 'This file can’t be edited from this canvas.',
} as const;

/** Whether the person has something to read or act on; a healthy file shows nothing. */
function needsAttention(recovery: Recovery): boolean {
  if (!recovery.supported) return false;
  if (
    recovery.phase === 'unavailable' ||
    recovery.phase === 'refused' ||
    recovery.phase === 'local_uncertain'
  )
    return true;
  return (
    recovery.discovery?.admission === 'blocked' ||
    recovery.discovery?.entries.some((entry) => entry.state === 'review') === true ||
    recovery.historical?.state === 'receipt'
  );
}

/** The notice text and its one action, for a file that {@link needsAttention}. */
function NoticeBody({
  recovery,
  editing,
  loadCurrent,
}: {
  recovery: Recovery;
  editing: boolean;
  loadCurrent: () => void;
}) {
  if (recovery.phase === 'unavailable' || recovery.phase === 'refused') {
    // Placed by FileSaveTopBar's grid: the sentence takes the text column, and
    // "Check again" joins the action group when there's room, or drops under the
    // sentence when there isn't. It's the view's one action, never mid-sentence.
    return (
      <>
        <p role="alert" className="col-start-1 row-start-1 py-1.5">
          {FAILED_CHECK[recovery.phase]}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="col-span-2 col-start-1 row-start-2 mb-1.5 justify-self-start @md:col-span-1 @md:col-start-2 @md:row-start-1 @md:mb-0"
          disabled={recovery.busy || editing}
          onClick={() => void recovery.refresh()}
        >
          Check again
        </Button>
      </>
    );
  }
  if (recovery.phase === 'local_uncertain')
    return (
      <p role="alert">Use Retry original save. Checking previous saves won’t confirm this save.</p>
    );
  const discovery = recovery.discovery;
  return (
    <div className="space-y-1">
      {discovery?.admission === 'blocked' && (
        <p role="alert">
          An unresolved original save blocks this file. This list may not include the blocking
          operation.
        </p>
      )}
      {discovery?.hasMore && (
        <p>Only the latest 25 matching saves are shown. Older evidence is omitted.</p>
      )}
      {discovery && discovery.entries.length > 0 && (
        <>
          <ul>
            {discovery.entries.map((entry) => (
              <li key={entry.eventId}>
                <span>
                  {entry.eventId}:{' '}
                  {entry.state === 'receipt'
                    ? 'Historical save recorded'
                    : entry.state === 'review'
                      ? 'Original save needs review'
                      : entry.state === 'no_op'
                        ? 'Original save made no change'
                        : 'Original save failed before replacement'}
                </span>
                {entry.state === 'review' &&
                  (entry.reason === 'prepared_without_replacement' ? (
                    <p>This save needs manual review. These controls won’t write the file.</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <p>
                        The original saved replacement must be proven before its receipt can be
                        settled.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={recovery.busy || editing}
                        onClick={() => void recovery.recover(entry.eventId)}
                      >
                        Recover original receipt
                      </Button>
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        </>
      )}
      {discovery?.admission === 'blocked' && discovery.entries.length === 0 && (
        <p>No matching recent saves.</p>
      )}
      {recovery.historical?.state === 'receipt' && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div>
            <p>Previous save confirmed. Your current draft may differ.</p>
            <p>
              {recovery.historical.currentFileMatch === 'different'
                ? 'The current file differs from that historical save.'
                : recovery.historical.currentFileMatch === 'same_saved_replacement'
                  ? 'The saved replacement matched when checked; current bytes still require a fresh load.'
                  : 'The current file was not checked.'}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={editing || recovery.editBlocked || recovery.busy}
            onClick={loadCurrent}
          >
            Load current file
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The quiet way to the proof-only controls on a healthy file: re-check previous
 * saves, or load the current file through the same serialized lane.
 */
export function FileSaveMoreMenu({
  recovery,
  editing,
  loadCurrent,
}: {
  recovery: Recovery;
  editing: boolean;
  loadCurrent: () => void;
}) {
  if (!recovery.supported || editing) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="text-muted-foreground hover:text-foreground"
          aria-label="More file actions"
        >
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={recovery.busy} onSelect={() => void recovery.refresh()}>
          Check previous saves
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={recovery.editBlocked || recovery.busy}
          onSelect={() => loadCurrent()}
        >
          Load current file
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The editor's top row: the file's own buttons on the right and, when the file
 * needs the person, what needs them on the left, in one tinted block.
 *
 * A healthy file shows only the buttons. A failed check puts its sentence on
 * the left and "Check again" with the buttons on the right, dropping the action
 * under the sentence in a narrow panel. Longer notices float the buttons right
 * so their text wraps under them. The buttons keep the same place in the tree
 * either way, so a notice arriving or leaving never remounts them or drops their
 * focus.
 */
export function FileSaveTopBar({
  recovery,
  editing,
  loadCurrent,
  toolbar,
}: {
  recovery: Recovery;
  editing: boolean;
  loadCurrent: () => void;
  toolbar: ReactNode;
}) {
  const notice = needsAttention(recovery);
  // A failed check is one sentence and one action, laid out on a grid so the
  // action sits with the buttons; longer notices keep the float so their text
  // wraps under the buttons.
  const failed = recovery.phase === 'unavailable' || recovery.phase === 'refused';
  return (
    <>
      {recovery.supported && recovery.phase === 'pending' && (
        <p role="status" className="sr-only">
          Checking previous saves…
        </p>
      )}
      <div
        {...(notice ? { role: 'region', 'aria-label': 'Previous file saves' } : {})}
        className={cn(
          'shrink-0',
          notice
            ? 'bg-muted text-foreground mx-2 mt-2 rounded-md py-1 pr-1 pl-3 text-sm'
            : 'flex justify-end px-2 pt-1',
          notice && (failed ? '@container' : 'flow-root')
        )}
      >
        <div
          className={cn(
            notice &&
              failed &&
              'grid grid-cols-[1fr_auto] items-center gap-x-2 @md:grid-cols-[1fr_auto_auto]'
          )}
        >
          <div
            className={cn(
              'flex items-center gap-1',
              notice && !failed && 'float-right ml-2',
              notice && failed && 'col-start-2 row-start-1 @md:col-start-3'
            )}
          >
            {toolbar}
          </div>
          {notice &&
            (failed ? (
              <NoticeBody recovery={recovery} editing={editing} loadCurrent={loadCurrent} />
            ) : (
              <div className="py-1.5">
                <NoticeBody recovery={recovery} editing={editing} loadCurrent={loadCurrent} />
              </div>
            ))}
        </div>
      </div>
    </>
  );
}
