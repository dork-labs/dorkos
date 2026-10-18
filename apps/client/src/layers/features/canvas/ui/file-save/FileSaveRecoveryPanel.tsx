/** Historical save evidence never claims the current draft or an agent delivery was saved. */
import { Button, Notice } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { useFileSaveRecovery } from '../../model/file-save/use-file-save-recovery';
/**
 * The one sentence a failed check leaves, with "Check again" beside it. A 404
 * (`refused`) is the server saying this file is never saved from here; anything
 * else is a fault worth retrying.
 */
const FAILED_CHECK = {
  unavailable: 'Couldn’t check previous saves, so editing is off.',
  refused: 'This file can’t be edited from this canvas.',
} as const;

/**
 * Below the editor's floating refresh and edit buttons (`size-9`, `size-11`
 * under `md`, at `mt-2`), so they never sit on top of this text.
 */
const FRAME = 'mx-2 mt-14 md:mt-12';

/** Show bounded original-save evidence and explicit proof-only recovery controls. */
export function FileSaveRecoveryPanel({
  recovery,
  editing,
  loadCurrent,
}: {
  recovery: ReturnType<typeof useFileSaveRecovery>;
  editing: boolean;
  loadCurrent: () => void;
}) {
  if (!recovery.supported) return null;
  if (recovery.phase === 'unavailable' || recovery.phase === 'refused') {
    return (
      <Notice
        role="region"
        aria-label="Previous file saves"
        className={cn(FRAME, 'flex flex-wrap items-center gap-x-3 gap-y-1')}
      >
        <p role="alert" className="min-w-0 flex-1 basis-48">
          {FAILED_CHECK[recovery.phase]}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={recovery.busy || editing}
          onClick={() => void recovery.refresh()}
        >
          Check again
        </Button>
      </Notice>
    );
  }
  return (
    <Notice
      role="region"
      aria-label="Previous file saves"
      className={cn(FRAME, 'flex flex-wrap items-start gap-x-3 gap-y-2')}
    >
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        {recovery.phase === 'pending' && <p role="status">Checking previous saves…</p>}
        {recovery.phase === 'local_uncertain' && (
          <p role="alert">
            Use Retry original save. Checking previous saves won’t confirm this save.
          </p>
        )}
        {recovery.discovery?.admission === 'blocked' && (
          <p role="alert">
            An unresolved original save blocks this file. This list may not include the blocking
            operation.
          </p>
        )}
        {recovery.discovery && (
          <>
            {!recovery.discovery.entries.length && <p>No matching recent saves.</p>}
            {recovery.discovery.hasMore && (
              <p>Only the latest 25 matching saves are shown. Older evidence is omitted.</p>
            )}
            <ul>
              {recovery.discovery.entries.map((entry) => (
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
                      <>
                        <p>
                          The original saved replacement must be proven before its receipt can be
                          settled.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={recovery.busy || editing}
                          onClick={() => void recovery.recover(entry.eventId)}
                        >
                          Recover original receipt
                        </Button>
                      </>
                    ))}
                </li>
              ))}
            </ul>
          </>
        )}
        {recovery.historical?.state === 'receipt' && (
          <div role="status">
            <p>Previous save confirmed. Your current draft may differ.</p>
            <p>
              {recovery.historical.currentFileMatch === 'different'
                ? 'The current file differs from that historical save.'
                : recovery.historical.currentFileMatch === 'same_saved_replacement'
                  ? 'The saved replacement matched when checked; current bytes still require a fresh load.'
                  : 'The current file was not checked.'}
            </p>
          </div>
        )}
        <p className="text-muted-foreground">
          These controls don’t resend drafts or confirm agent delivery. Use Load current file.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={recovery.busy || editing}
          onClick={() => void recovery.refresh()}
        >
          Check previous saves
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={editing || recovery.editBlocked || recovery.busy}
          onClick={loadCurrent}
        >
          Load current file
        </Button>
      </div>
    </Notice>
  );
}
