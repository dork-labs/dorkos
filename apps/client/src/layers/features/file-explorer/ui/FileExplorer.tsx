import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, File, FilePlus, Folder, FolderPlus, Loader2, RefreshCw } from 'lucide-react';
import type { FileEntry } from '@dorkos/shared/types';
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
import { useAppStore } from '@/layers/shared/model';
import { ROOT_KEY } from '../model/tree-reducer';
import { useFileExplorer } from '../model/use-file-explorer';
import { FileTree } from './FileTree';
import { WorkspaceBadge } from './WorkspaceBadge';

/** In-progress inline create: the target parent directory and the entry type. */
interface DraftCreate {
  parent: string;
  type: 'file' | 'dir';
}

/**
 * The Files right-panel tab (spec right-panel-workbench, Chunk B): a lazy,
 * worktree-aware tree of the session cwd with full CRUD. Files open into the
 * canvas via the shared `open_file` command; directory writes are optimistic
 * with rollback + coded-error toasts. The whole feature is lazy-loaded by the
 * right-panel contribution.
 *
 * @module features/file-explorer/ui/FileExplorer
 */
export function FileExplorer() {
  const cwd = useAppStore((s) => s.selectedCwd);
  const explorer = useFileExplorer(cwd);
  const { rows, rootLoading, showHidden, setShowHidden } = explorer;

  const [draft, setDraft] = useState<DraftCreate | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const startCreate = useCallback(
    (parent: string, type: 'file' | 'dir') => {
      explorer.ensureExpanded(parent);
      setRenamingPath(null);
      setDraft({ parent, type });
    },
    [explorer]
  );

  const submitDraft = useCallback(
    async (name: string) => {
      if (!draft) return;
      const target = draft;
      setDraft(null);
      await explorer.createEntry(target.parent, name, target.type);
    },
    [draft, explorer]
  );

  const submitRename = useCallback(
    async (entry: FileEntry, newName: string) => {
      setRenamingPath(null);
      await explorer.renameEntry(entry, newName);
    },
    [explorer]
  );

  if (!cwd) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
        Select a working directory to browse its files.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Folder className="text-muted-foreground size-(--size-icon-sm) flex-shrink-0" />
        <span className="text-sm font-medium">Files</span>
        <WorkspaceBadge cwd={cwd} />
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New File"
          title="New File"
          onClick={() => startCreate(ROOT_KEY, 'file')}
        >
          <FilePlus className="text-muted-foreground" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New Folder"
          title="New Folder"
          onClick={() => startCreate(ROOT_KEY, 'dir')}
        >
          <FolderPlus className="text-muted-foreground" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
          title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
          onClick={() => setShowHidden(!showHidden)}
        >
          {showHidden ? (
            <Eye className="text-muted-foreground" />
          ) : (
            <EyeOff className="text-muted-foreground" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh"
          title="Refresh"
          onClick={explorer.reload}
        >
          <RefreshCw className="text-muted-foreground" />
        </Button>
      </header>

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
        ) : rows.length === 0 && !draft ? (
          <div className="text-muted-foreground/60 flex h-20 items-center justify-center text-xs">
            Empty directory
          </div>
        ) : (
          <FileTree
            rows={rows}
            selectedPath={selectedPath}
            renamingPath={renamingPath}
            onSelectPath={setSelectedPath}
            onToggle={explorer.toggleExpand}
            onOpen={explorer.openFile}
            onSubmitRename={(entry, name) => void submitRename(entry, name)}
            onCancelRename={() => setRenamingPath(null)}
            onStartRename={(entry) => setRenamingPath(entry.path)}
            onNewFile={(parent) => startCreate(parent, 'file')}
            onNewFolder={(parent) => startCreate(parent, 'dir')}
            onDelete={(entry) => void explorer.removeEntry(entry)}
            onMove={(from, toDir) => void explorer.moveEntry(from, toDir)}
          />
        )}
      </div>

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
