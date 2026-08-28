import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { File, Folder, Loader2, RotateCw } from 'lucide-react';
import type { ExplorerEntry, FileExplorerSource } from '../model/source';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { isAtOrUnder, joinPath, parentOf, ROOT_KEY } from '../model/tree';
import { useFileExplorer } from '../model/use-file-explorer';
import { createSessionCwdSource } from '../model/session-cwd-source';
import { useFileExplorerStore } from '../model/file-explorer-store';
import { FileTree } from './FileTree';
import { FilePreviewDialog } from './FilePreviewDialog';

/** In-progress inline create: the target parent directory and the entry type. */
interface DraftCreate {
  parent: string;
  type: 'file' | 'dir';
}

/** What {@link FileExplorer} renders over. */
export interface FileExplorerProps {
  /**
   * Where the entries come from. Omitted means the session's selected working
   * directory, which is what the Files right-panel tab has always shown.
   *
   * **Memoize it.** The pane subscribes to the source's `events` and keys its
   * cache off its identity, so a source rebuilt every render resubscribes every
   * render. `useMemo` over the ids it is built from is the whole discipline.
   */
  source?: FileExplorerSource | null;
  /** Extra classes for the pane container, for a surface that is not a whole tab. */
  className?: string;
}

/**
 * The file explorer (spec right-panel-workbench Chunk B, sources by
 * `project-rooms` §3.9): a lazy tree of whatever its source lists, with the
 * writes its source allows.
 *
 * Over a session's working directory that is the pane it has always been —
 * full CRUD, optimistic with rollback and coded-error toasts, files opening
 * into the canvas through the shared `open_file` command. Over a room's own
 * files the same tree is read-only, carries a provenance column, and previews
 * a file in place, because a commit has no disk to write to and no session to
 * open a document beside.
 *
 * @module features/file-explorer/ui/FileExplorer
 */
export function FileExplorer({ source: sourceProp, className }: FileExplorerProps = {}) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);
  // Built here rather than by the right-panel registration, so the Files tab
  // stays a component with no props and the session default lives in one place.
  const sessionSource = useMemo(
    () => (cwd ? createSessionCwdSource({ transport, cwd }) : null),
    [transport, cwd]
  );
  const source = sourceProp === undefined ? sessionSource : sourceProp;
  const readOnly = source !== null && !source.writable;
  const explorer = useFileExplorer(source);
  const { rows, rootLoading, rootError, errorPaths } = explorer;
  const setCommands = useFileExplorerStore((s) => s.setCommands);
  // Selection lives in the store (DOR-404 D1) so it survives an unmount and a
  // refresh; `renamingPath`/`draft` stay component-local (ephemeral, D7).
  const selectedPath = useFileExplorerStore((s) => s.selectedPath);
  const setSelectedPath = useFileExplorerStore((s) => s.setSelectedPath);
  const clipboard = useFileExplorerStore((s) => s.clipboard);

  const [draft, setDraft] = useState<DraftCreate | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // The file an in-pane preview is showing, for a source with nowhere else to
  // put it. Component-local: a preview is a look, not a place you return to.
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  // Paste is offered only where it could actually land: something has to be on
  // the clipboard, and a folder cannot be pasted inside itself. Dimming the
  // item is what makes that legible — the refusal toast is the safety net for
  // the keyboard, not the explanation.
  const canPasteInto = useCallback(
    (toDir: string): boolean =>
      clipboard !== null && !(clipboard.isDir && isAtOrUnder(toDir, clipboard.path)),
    [clipboard]
  );

  const startCreate = useCallback(
    (parent: string, type: 'file' | 'dir') => {
      explorer.ensureExpanded(parent);
      setRenamingPath(null);
      setDraft({ parent, type });
    },
    [explorer]
  );

  // Publish toolbar commands for the header-mounted FileExplorerActions. Latest
  // handlers are read through a ref so the published bridge stays stable (set
  // once on mount, cleared on unmount) without re-registering each render.
  const commandHandlersRef = useRef({ startCreate, reload: explorer.reload });
  useEffect(() => {
    commandHandlersRef.current = { startCreate, reload: explorer.reload };
  });
  // Only the writable pane publishes them: the toolbar they drive is the Files
  // tab's header, whose New File and New Folder a read-only source could not
  // honour — and a second publisher would clear the first's on unmount.
  useEffect(() => {
    if (readOnly) return;
    setCommands({
      newFile: () => commandHandlersRef.current.startCreate(ROOT_KEY, 'file'),
      newFolder: () => commandHandlersRef.current.startCreate(ROOT_KEY, 'dir'),
      refresh: () => commandHandlersRef.current.reload(),
    });
    return () => setCommands(null);
  }, [setCommands, readOnly]);

  const submitDraft = useCallback(
    async (name: string) => {
      if (!draft) return;
      const target = draft;
      setDraft(null);
      const ok = await explorer.createEntry(target.parent, name, target.type);
      // Select the freshly-created entry (§3.4) so it becomes the keyboard anchor.
      if (ok) setSelectedPath(joinPath(target.parent, name));
    },
    [draft, explorer, setSelectedPath]
  );

  const submitRename = useCallback(
    async (entry: ExplorerEntry, newName: string) => {
      setRenamingPath(null);
      const ok = await explorer.renameEntry(entry, newName);
      if (ok) setSelectedPath(joinPath(parentOf(entry.path), newName));
    },
    [explorer, setSelectedPath]
  );

  if (source === null) {
    // Only the session pane has a sentence to say here: a caller that passed a
    // null source of its own already decided what "nothing to browse" looks
    // like on its surface.
    if (sourceProp !== undefined) return null;
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
        Select a working directory to browse its files.
      </div>
    );
  }

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="min-h-0 flex-1">
        {draft && (
          <DraftRow
            type={draft.type}
            onSubmit={(name) => void submitDraft(name)}
            onCancel={() => setDraft(null)}
          />
        )}
        {rootLoading && rows.length === 0 ? (
          <div className="flex h-20 items-center justify-center">
            <Loader2 className="text-muted-foreground size-(--size-icon-md) animate-spin" />
          </div>
        ) : rootError && rows.length === 0 ? (
          <div className="text-muted-foreground flex h-20 flex-col items-center justify-center gap-2 text-xs">
            <span>Couldn&apos;t load files.</span>
            <Button variant="outline" size="xs" onClick={explorer.reload}>
              <RotateCw />
              Retry
            </Button>
          </div>
        ) : rows.length === 0 && !draft ? (
          <div className="text-muted-foreground/60 flex h-20 items-center justify-center text-xs">
            Empty directory
          </div>
        ) : (
          <FileTree
            rows={rows}
            selectedPath={selectedPath}
            renamingPath={renamingPath}
            errorPaths={errorPaths}
            onSelectPath={setSelectedPath}
            onToggle={explorer.toggleExpand}
            onOpen={(entry) => {
              // A canvas source pushes the document somewhere else; an in-pane
              // source shows it right here.
              if (source.preview === 'inline') setPreviewPath(entry.path);
              else explorer.openFile(entry);
            }}
            onRetryDir={explorer.retryDir}
            onSubmitRename={(entry, name) => void submitRename(entry, name)}
            onCancelRename={() => setRenamingPath(null)}
            onStartRename={(entry) => setRenamingPath(entry.path)}
            onNewFile={(parent) => startCreate(parent, 'file')}
            onNewFolder={(parent) => startCreate(parent, 'dir')}
            onDelete={(entry) => void explorer.removeEntry(entry)}
            onMove={(from, toDir) => void explorer.moveEntry(from, toDir)}
            onCopyInto={(from, toDir) => void explorer.copyEntry(from, toDir)}
            onCopy={explorer.copyToClipboard}
            onPaste={(toDir) => {
              if (clipboard) void explorer.copyEntry(clipboard, toDir);
            }}
            onDuplicate={(entry) =>
              void explorer.copyEntry(
                { path: entry.path, isDir: entry.type === 'dir' },
                parentOf(entry.path)
              )
            }
            canPasteInto={canPasteInto}
            readOnly={readOnly}
            provenance={source.provenance}
            revealLabel={explorer.revealLabel}
            onReveal={(entry) => void explorer.reveal(entry)}
            onAddToChat={explorer.addToChat}
            onCopyPath={(entry, kind) => void explorer.copyPath(entry, kind)}
          />
        )}
      </div>

      {source.preview === 'inline' && (
        <FilePreviewDialog
          source={source}
          path={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}

      <AlertDialog
        open={explorer.pendingRecursiveDelete !== null}
        onOpenChange={(open) => !open && explorer.cancelRecursiveDelete()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this folder?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{explorer.pendingRecursiveDelete?.name}&rdquo; isn&apos;t empty. Deleting it
              removes everything inside. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={explorer.cancelRecursiveDelete}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void explorer.confirmRecursiveDelete()}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Inline input row for an in-progress create, pinned to the top of the tree body. */
function DraftRow({
  type,
  onSubmit,
  onCancel,
}: {
  type: 'file' | 'dir';
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <div className="flex items-center gap-1 px-3 py-1">
      {type === 'dir' ? (
        <Folder className="size-(--size-icon-sm) flex-shrink-0 text-sky-500" />
      ) : (
        <File className="text-muted-foreground size-(--size-icon-sm) flex-shrink-0" />
      )}
      <input
        ref={ref}
        type="text"
        value={value}
        aria-label={type === 'dir' ? 'New folder name' : 'New file name'}
        placeholder={type === 'dir' ? 'folder-name' : 'file-name'}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') onCancel();
        }}
        className="border-border bg-background min-w-0 flex-1 rounded border px-1 py-0 text-sm outline-none"
      />
    </div>
  );
}
