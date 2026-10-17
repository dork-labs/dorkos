import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Pencil } from 'lucide-react';
import type { BlintzPlugin } from 'blintz';
import type { DocRef } from '@dorkos/shared/doc-collab';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { changeLine, presenceLine } from '../lib/presence-copy';
import { useLiveDoc } from '../model/use-live-doc';
import { useLiveDocUser } from '../model/use-live-doc-user';
import { UnsavedDraftNotice } from './UnsavedDraftNotice';
import { VersionsMenu } from './VersionsMenu';

/** What {@link LiveDocEditorProps.renderEditor} is handed. */
export interface LiveEditorBinding {
  /** The plugins that bind the editor to the live doc. */
  plugins: BlintzPlugin[];
  /** Remount the editor whenever this changes: Blintz reads its plugins at mount. */
  key: string;
  /** Whether the person is editing; read-only views stay live. */
  editable: boolean;
  /** Report the editor's markdown on every change, so nothing typed is ever lost. */
  onChange: (markdown: string) => void;
}

/** Props for {@link LiveDocEditor}. */
export interface LiveDocEditorProps {
  /** The doc: the session folder and the markdown file's path inside it. */
  doc: DocRef;
  /** The editor, bound to the live doc. */
  renderEditor: (live: LiveEditorBinding) => ReactNode;
  /** Today's editor, which saves the file itself, for a doc that cannot be edited live. */
  fallback: ReactNode;
  /** The file changed outside the fallback editor (a restore, a saved draft): reload it. */
  onFileChanged?: () => void;
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
 * nothing needs saving. Opens read-only, like every canvas doc, with the same
 * pencil to start editing. Shows who else is here, quietly, and the doc's
 * saved versions to put one back.
 *
 * Nothing typed here is dropped. When the server's copy is replaced while
 * this one held edits, they are kept as a version. When live editing stops
 * for good after this editor typed into it, the text is offered back to save
 * to the file. Falls back to `fallback` (the editor that saves the file) when
 * the server will not serve the doc live, so a doc always opens.
 */
export function LiveDocEditor({ doc, renderEditor, fallback, onFileChanged }: LiveDocEditorProps) {
  const transport = useTransport();
  const user = useLiveDocUser();
  const live = useLiveDoc(doc, user);
  const [editing, setEditing] = useState(false);
  // The doc as this editor last showed it, kept outside render on purpose:
  // it changes on every keystroke and only matters when the copy goes away.
  const latest = useRef<string | null>(null);
  const onChange = useCallback((markdown: string) => {
    latest.current = markdown;
  }, []);
  // Callers pass an inline function; only the newest one is ever called.
  const fileChanged = useRef(onFileChanged);
  useEffect(() => {
    fileChanged.current = onFileChanged;
  });

  // Text that never reached the file, offered back once: from a fresh copy
  // replacing one with unsaved edits (when keeping them as a version failed),
  // or from live editing stopping for good after the person typed.
  type Offer = { draft: string; basedOn: string | null; reason: 'stopped' | 'replaced' };
  const [offer, setOffer] = useState<Offer | null>(null);
  const [keptLost, setKeptLost] = useState(false);
  const handledLost = useRef(0);
  const savedHash = live.savedHash;
  useEffect(() => {
    if (live.lostEdits <= handledLost.current) return;
    handledLost.current = live.lostEdits;
    const text = latest.current;
    if (text === null) return;
    transport.keepDocDraft(doc, text).then(
      () => setKeptLost(true),
      () => setOffer({ draft: text, basedOn: savedHash, reason: 'replaced' })
    );
  }, [live.lostEdits, transport, doc, savedHash]);

  const ownEditsUnsaved = live.ownEditsUnsaved;
  useEffect(() => {
    if (live.status !== 'unavailable' || !live.everLive) return;
    const text = latest.current;
    // Only text the file does not have: edits that were all saved need nothing.
    if (text !== null && ownEditsUnsaved) {
      setOffer((current) => current ?? { draft: text, basedOn: savedHash, reason: 'stopped' });
    }
    fileChanged.current?.();
  }, [live.status, live.everLive, savedHash, ownEditsUnsaved]);
  const offerDone = useCallback((changed: boolean) => {
    setOffer(null);
    if (changed) fileChanged.current?.();
  }, []);
  const restored = useCallback((wasLive: boolean) => {
    if (!wasLive) fileChanged.current?.();
  }, []);
  const notice = offer && (
    <UnsavedDraftNotice
      doc={doc}
      draft={offer.draft}
      basedOn={offer.basedOn}
      reason={offer.reason}
      onDone={offerDone}
    />
  );

  if (live.status === 'unavailable') {
    return (
      <div className="relative flex h-full flex-col">
        <div className="flex justify-end px-2 pt-1">
          <VersionsMenu doc={doc} onRestored={restored} />
        </div>
        {notice}
        <div className="min-h-0 flex-1">{fallback}</div>
      </div>
    );
  }
  // Never an editor on a copy that has not arrived: it would show an empty
  // page, and its first paragraph would merge in beside the real ones.
  if (!live.synced || !live.plugins) {
    return (
      <div className="flex h-full flex-col">
        {notice}
        <div className="text-muted-foreground p-4 text-sm">Loading editor…</div>
      </div>
    );
  }

  const status =
    live.status === 'reconnecting'
      ? 'Reconnecting. Your edits sync when it’s back.'
      : live.gone
        ? 'This file was moved or deleted. Its text is kept as a version.'
        : keptLost
          ? 'Your edits from before the reconnect are kept as a version.'
          : live.recentChange
            ? changeLine(live.recentChange)
            : presenceLine(live.others);

  return (
    <div className="relative flex h-full flex-col" data-live-doc={live.status}>
      <div className="flex min-h-8 items-center justify-end gap-2 px-2 pt-1">
        {status && <StatusLine>{status}</StatusLine>}
        <VersionsMenu doc={doc} />
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setEditing((on) => !on)}
          aria-label={editing ? 'Finish editing' : 'Edit document'}
        >
          {editing ? <Check className="size-4" /> : <Pencil className="size-4" />}
        </Button>
      </div>
      {notice}
      <div className="min-h-0 flex-1">
        {/* eslint-disable-next-line react-hooks/refs -- onChange writes the ref when the editor changes, never during render */}
        {renderEditor({
          plugins: live.plugins,
          key: `live-${live.epoch}`,
          editable: editing,
          onChange,
        })}
      </div>
    </div>
  );
}
