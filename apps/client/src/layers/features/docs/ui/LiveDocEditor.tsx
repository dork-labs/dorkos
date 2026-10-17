import type { ReactNode } from 'react';
import type { BlintzPlugin } from 'blintz';
import type { DocRef } from '@dorkos/shared/doc-collab';
import { changeLine, presenceLine } from '../lib/presence-copy';
import { useLiveDoc } from '../model/use-live-doc';
import { useLiveDocUser } from '../model/use-live-doc-user';
import { RestoreVersionAction } from './RestoreVersionAction';

/** Props for {@link LiveDocEditor}. */
export interface LiveDocEditorProps {
  /** The doc: the session folder and the markdown file's path inside it. */
  doc: DocRef;
  /**
   * The editor, bound to the live doc by `plugins`. Remount it whenever `key`
   * changes: Blintz reads its plugins at mount.
   */
  renderEditor: (live: { plugins: BlintzPlugin[]; key: string }) => ReactNode;
  /** Today's editor, which saves the file itself, for a doc that cannot be edited live. */
  fallback: ReactNode;
  /** Called after a restore while the doc was not live, so the fallback can reload the file. */
  onRestored?: () => void;
}

/** One quiet status line, or nothing. */
function StatusLine({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground truncate text-xs" aria-live="polite">
      {children}
    </span>
  );
}

/**
 * A markdown doc edited live (DOR-2984): everyone with it open edits the same
 * copy, an agent's write merges in without touching anyone's typing, and
 * nothing needs saving. Shows who else is here, quietly, and offers "Restore
 * previous version" after a change made outside the editor.
 *
 * Falls back to `fallback` (the editor that saves the file) when the server
 * will not serve the doc live, so a doc always opens.
 */
export function LiveDocEditor({ doc, renderEditor, fallback, onRestored }: LiveDocEditorProps) {
  const user = useLiveDocUser();
  const live = useLiveDoc(doc, user);

  if (live.status === 'unavailable') {
    return (
      <div className="relative flex h-full flex-col">
        <div className="flex justify-end px-2 pt-1">
          <RestoreVersionAction doc={doc} onRestored={(wasLive) => !wasLive && onRestored?.()} />
        </div>
        <div className="min-h-0 flex-1">{fallback}</div>
      </div>
    );
  }
  if (live.status === 'connecting' || !live.plugins) {
    return <div className="text-muted-foreground p-4 text-sm">Loading editor…</div>;
  }

  const status =
    live.status === 'reconnecting'
      ? 'Reconnecting. Your edits are kept here.'
      : live.offlineEditsLost
        ? 'Edits made while offline couldn’t be kept.'
        : live.recentChange
          ? changeLine(live.recentChange)
          : presenceLine(live.others);

  return (
    <div className="relative flex h-full flex-col" data-live-doc={live.status}>
      <div className="flex min-h-8 items-center justify-end gap-2 px-2 pt-1">
        {status && <StatusLine>{status}</StatusLine>}
        <RestoreVersionAction doc={doc} />
      </div>
      <div className="min-h-0 flex-1">
        {renderEditor({ plugins: live.plugins, key: `live-${live.epoch}` })}
      </div>
    </div>
  );
}
