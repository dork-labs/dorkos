import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { File, Folder, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import type { ExplorerEntry, ExplorerListing, FileExplorerSource } from '../model/source';
import { explorerDirQueryKey } from '../model/source';
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
  Spinner,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { useQueryClient } from '@tanstack/react-query';
import { isAtOrUnder, joinPath, parentOf, ROOT_KEY } from '../model/tree';
import { useFileExplorer } from '../model/use-file-explorer';
import { createSessionCwdSource } from '../model/session-cwd-source';
import { useFileExplorerStore, type FileExplorerCommands } from '../model/file-explorer-store';
import { droppedFiles, hasOutsideFiles } from '../lib/dropped-files';
import { nameTakenMessage } from '../lib/crud-errors';
import { FileTree } from './FileTree';
import { FilePreviewDialog } from './FilePreviewDialog';
import { SourceChangeDialogs } from './SourceChangeDialogs';

/** In-progress inline create: the target parent directory and the entry type. */
interface DraftCreate {
  parent: string;
  type: 'file' | 'dir';
  /**
   * Set on the second step of a new folder in a source whose folders exist only
   * by holding files (a room's): the folder being made, whose first file this
   * draft names.
   */
  firstInFolder?: string;
}

/** The file an in-pane preview is showing, and whether it exists yet. */
interface PreviewTarget {
  path: string;
  /** A file being written for the first time — it appears when it is saved. */
  isNew: boolean;
}

/**
 * What a new name that is already taken says: the plain "already there" when
 * it is spelled the same, and why a different spelling still counts when only
 * capitals differ.
 *
 * @param name - The name the person typed.
 * @param clash - What the folder already holds under that name.
 */
function nameClashMessage(name: string, clash: ExplorerEntry): string {
  if (clash.name === name) return nameTakenMessage(name);
  return `There’s already “${clash.name}” there, and a name that differs only in capital letters is the same ${clash.type === 'dir' ? 'folder' : 'file'} on some computers. Pick another name.`;
}

/** What a drop that held only folders is told — an upload takes files. */
const DROP_FOLDERS_MESSAGE =
  'Folders can’t be uploaded whole. Open the folder and drop the files inside it.';

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
  /**
   * Where to publish the toolbar commands, for a surface that draws its own
   * toolbar (the room panel's Files section).
   *
   * Omitted, the session pane publishes them to the store the Files tab's
   * header reads — and only the session pane does, so a room's pane never
   * takes over that header.
   */
  onCommands?: (commands: FileExplorerCommands | null) => void;
}

/**
 * The file explorer (spec right-panel-workbench Chunk B, sources by
 * `project-rooms` §3.9): a lazy tree of whatever its source lists, with the
 * writes its source allows.
 *
 * Over a session's working directory that is the pane it has always been —
 * full CRUD, optimistic with rollback and coded-error toasts, files opening
 * into the canvas through the shared `open_file` command. Over a room's own
 * files (spec `agent-home-desk` §7.3) the same tree carries a provenance
 * column, previews a file in place, and makes every change through the
 * source's own door — one commit each, a new file written in the editor
 * before it exists, uploads dropped from outside the app, every delete
 * confirmed, and a lost race put to the person as a choice — because a commit
 * has no disk to write to and no session to open a document beside.
 *
 * @module features/file-explorer/ui/FileExplorer
 */
export function FileExplorer({
  source: sourceProp,
  className,
  onCommands,
}: FileExplorerProps = {}) {
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
  const changes = explorer.changes;
  const queryClient = useQueryClient();
  const showHidden = useFileExplorerStore((s) => s.showHidden);
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
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const setPreviewPath = useCallback(
    (path: string | null) => setPreview(path === null ? null : { path, isNew: false }),
    []
  );

  // Upload: the folder the file picker will fill, and the picker itself.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadDirRef = useRef<string>(ROOT_KEY);
  const [rootDropTarget, setRootDropTarget] = useState(false);

  const uploadInto = useCallback(
    (dir: string, files: File[]) => {
      if (changes === null) return;
      if (files.length === 0) {
        toast.error(DROP_FOLDERS_MESSAGE);
        return;
      }
      explorer.ensureExpanded(dir);
      void changes.upload(dir, files);
    },
    [changes, explorer]
  );

  // The pane's own element, for handing the keyboard back to its tree.
  const paneRef = useRef<HTMLDivElement>(null);
  const returnFocusToTree = useCallback(() => {
    paneRef.current?.querySelector<HTMLElement>('[role="tree"]')?.focus();
  }, []);

  const pickUpload = useCallback((dir: string) => {
    uploadDirRef.current = dir;
    fileInputRef.current?.click();
  }, []);

  // Paste is offered only where it could actually land: something has to be on
  // the clipboard, and a folder cannot be pasted inside itself. Dimming the
  // item is what makes that legible — the refusal toast is the safety net for
  // the keyboard, not the explanation.
  const canPasteInto = useCallback(
    (toDir: string): boolean =>
      clipboard !== null && !(clipboard.isDir && isAtOrUnder(toDir, clipboard.path)),
    [clipboard]
  );

  // Both name fields are opened SYNCHRONOUSLY (`flushSync`), so the field has
  // the caret by the time the call returns. That is what a menu item marked
  // `movesFocus` checks for before it skips its own focus restore — rendered a
  // beat later, the field looked like it had taken no focus, the restore landed
  // on the row, and the blur cancelled the field before anybody could type.
  const startCreate = useCallback(
    (parent: string, type: 'file' | 'dir') => {
      explorer.ensureExpanded(parent);
      flushSync(() => {
        setRenamingPath(null);
        setDraft({ parent, type });
      });
    },
    [explorer]
  );

  const startRename = useCallback((entry: ExplorerEntry) => {
    flushSync(() => setRenamingPath(entry.path));
  }, []);

  // Publish toolbar commands for the header-mounted FileExplorerActions. Latest
  // handlers are read through a ref so the published bridge stays stable (set
  // once on mount, cleared on unmount) without re-registering each render.
  const commandHandlersRef = useRef({ startCreate, reload: explorer.reload, pickUpload });
  useEffect(() => {
    commandHandlersRef.current = { startCreate, reload: explorer.reload, pickUpload };
  });
  // A writable pane publishes them — to the surface that asked for them, or,
  // for the session pane only, to the Files tab's header. A room's pane never
  // publishes there: that header belongs to the session tree, and a second
  // publisher would clear the first's on unmount.
  const takesUploads = changes !== null;
  useEffect(() => {
    if (readOnly) return;
    if (onCommands === undefined && takesUploads) return;
    const publish = onCommands ?? setCommands;
    publish({
      newFile: () => commandHandlersRef.current.startCreate(ROOT_KEY, 'file'),
      newFolder: () => commandHandlersRef.current.startCreate(ROOT_KEY, 'dir'),
      refresh: () => commandHandlersRef.current.reload(),
      ...(takesUploads && { upload: () => commandHandlersRef.current.pickUpload(ROOT_KEY) }),
    });
    return () => publish(null);
  }, [setCommands, onCommands, readOnly, takesUploads]);

  const submitDraft = useCallback(
    async (name: string) => {
      if (!draft || source === null) return;
      const target = draft;
      setDraft(null);
      if (changes !== null) {
        const siblings =
          queryClient.getQueryData<ExplorerListing>(
            explorerDirQueryKey(source, target.parent, showHidden)
          )?.entries ?? [];
        // Compared without case: a room's files are checked out on machines
        // where `Notes.md` and `notes.md` are one file, so the room refuses the
        // second — better said before the person has written anything.
        const clash = siblings.find((e) => e.name.toLowerCase() === name.toLowerCase());
        // A room's folder is a place its files live, not a thing of its own —
        // git has no empty folders — so a new folder is named with its first
        // file, and appears when that file is saved. Naming a folder the room
        // already has, spelled the same, just puts the new file in it.
        if (target.type === 'dir') {
          if (clash !== undefined && !(clash.type === 'dir' && clash.name === name)) {
            toast.error(nameClashMessage(name, clash));
            return;
          }
          setDraft({ parent: joinPath(target.parent, name), type: 'file', firstInFolder: name });
          return;
        }
        if (clash !== undefined) {
          toast.error(nameClashMessage(name, clash));
          return;
        }
        const path = joinPath(target.parent, name);
        // A new file is written, not made: it opens in the editor, and the
        // room gets it — as one commit — when the person saves.
        setPreview({ path, isNew: true });
        return;
      }
      const ok = await explorer.createEntry(target.parent, name, target.type);
      // Select the freshly-created entry (§3.4) so it becomes the keyboard anchor.
      if (ok) setSelectedPath(joinPath(target.parent, name));
    },
    [draft, source, changes, queryClient, showHidden, explorer, setSelectedPath]
  );

  const submitRename = useCallback(
    async (entry: ExplorerEntry, newName: string) => {
      setRenamingPath(null);
      const ok = changes
        ? await changes.renameEntry(entry, newName)
        : await explorer.renameEntry(entry, newName);
      if (ok) setSelectedPath(joinPath(parentOf(entry.path), newName));
    },
    [changes, explorer, setSelectedPath]
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
    // The pane is a drop zone for files from outside the app, which is a
    // pointer-only gesture by nature; the keyboard's way to the same upload is
    // the Upload button and the row menu, so this container needs no role.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={paneRef}
      className={cn(
        'flex h-full flex-col',
        rootDropTarget && 'ring-ring/60 bg-accent/30 ring-1 ring-inset',
        className
      )}
      // Files from outside the app dropped anywhere a row did not claim land in
      // the top folder. Rows stop their own drag events, so this only ever sees
      // drops on empty space — including the whole pane of a room with no
      // files yet.
      onDragOver={(e) => {
        if (changes === null || !hasOutsideFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setRootDropTarget(true);
      }}
      onDragLeave={(e) => {
        // A leave into one of this pane's own children is not a leave.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setRootDropTarget(false);
      }}
      onDrop={(e) => {
        setRootDropTarget(false);
        if (changes === null || !hasOutsideFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        uploadInto(ROOT_KEY, droppedFiles(e.dataTransfer).files);
      }}
    >
      {changes !== null && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-hidden
          tabIndex={-1}
          data-testid="room-files-upload-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // Cleared so picking the same file again still fires a change.
            e.target.value = '';
            uploadInto(uploadDirRef.current, files);
          }}
        />
      )}
      <div className="min-h-0 flex-1">
        {draft && (
          <DraftRow
            key={`${draft.parent}:${draft.type}:${draft.firstInFolder ?? ''}`}
            type={draft.type}
            firstInFolder={draft.firstInFolder}
            onSubmit={(name) => void submitDraft(name)}
            onCancel={() => setDraft(null)}
          />
        )}
        {rootLoading && rows.length === 0 ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner size="md" className="text-muted-foreground" label="Loading files" />
          </div>
        ) : rootError && rows.length === 0 ? (
          <div className="text-muted-foreground flex h-20 flex-col items-center justify-center gap-2 text-xs">
            <span>Couldn’t load files.</span>
            <Button variant="outline" size="xs" onClick={explorer.reload}>
              <RotateCw />
              Retry
            </Button>
          </div>
        ) : rows.length === 0 && !draft ? (
          <div className="text-muted-foreground/60 flex h-20 items-center justify-center px-4 text-center text-xs">
            {changes !== null ? 'No files yet. Drop files here, or use Upload.' : 'Empty directory'}
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
            onStartRename={startRename}
            onNewFile={(parent) => startCreate(parent, 'file')}
            onNewFolder={(parent) => startCreate(parent, 'dir')}
            onDelete={(entry) =>
              changes ? changes.requestDelete(entry) : void explorer.removeEntry(entry)
            }
            onMove={(from, toDir) =>
              void (changes ? changes.moveEntry(from, toDir) : explorer.moveEntry(from, toDir))
            }
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
            copyable={changes === null}
            onDisk={source.cwd !== null}
            onUpload={changes ? uploadInto : undefined}
            onPickUpload={changes ? pickUpload : undefined}
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
          path={preview?.path ?? null}
          isNew={preview?.isNew ?? false}
          onCreated={() => {
            if (preview === null) return;
            setPreview({ path: preview.path, isNew: false });
            setSelectedPath(preview.path);
          }}
          onClose={() => setPreview(null)}
        />
      )}

      {changes !== null && (
        <SourceChangeDialogs
          changes={changes}
          onOpenTheirs={(path) => setPreviewPath(path)}
          onReturnFocus={returnFocusToTree}
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
              “{explorer.pendingRecursiveDelete?.name}” isn’t empty. Deleting it removes everything
              inside. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={explorer.cancelRecursiveDelete}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void explorer.confirmRecursiveDelete()}
              className="bg-destructive hover:bg-destructive/90 dark:bg-destructive/60 text-white"
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
  firstInFolder,
  onSubmit,
  onCancel,
}: {
  type: 'file' | 'dir';
  /** The folder this is the first file of, on a new folder's second step. */
  firstInFolder?: string;
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

  const input = (
    <div className="flex items-center gap-1">
      {type === 'dir' ? (
        <Folder className="size-(--size-icon-sm) flex-shrink-0 text-sky-500" />
      ) : (
        <File className="text-muted-foreground size-(--size-icon-sm) flex-shrink-0" />
      )}
      <input
        ref={ref}
        type="text"
        value={value}
        aria-label={
          firstInFolder !== undefined
            ? `First file in ${firstInFolder}`
            : type === 'dir'
              ? 'New folder name'
              : 'New file name'
        }
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

  if (firstInFolder === undefined) return <div className="px-3 py-1">{input}</div>;
  // The second step of a new folder: the folder is named, and the person is
  // told why they are being asked for a file too — a room keeps files, and a
  // folder is only where some of them live.
  return (
    <div className="space-y-1 px-3 py-1">
      <p className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
        <Folder className="size-(--size-icon-xs) flex-shrink-0 text-sky-500" />
        <span className="truncate">{firstInFolder}</span>
      </p>
      {input}
      <p className="text-muted-foreground text-2xs">
        Name its first file. The folder appears when you save it.
      </p>
    </div>
  );
}
