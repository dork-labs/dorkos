import { Eye, EyeOff, FilePlus, FolderPlus, RefreshCw } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { useFileExplorerStore } from '../model/file-explorer-store';
import { WorkspaceBadge } from './WorkspaceBadge';

/**
 * Files-panel header toolbar: New File, New Folder, Show/Hide hidden, Refresh,
 * plus the workspace badge. Registered as the Files contribution's
 * `headerActions`, so it renders inside the container-owned panel header. The
 * create/refresh buttons drive the mounted {@link FileExplorer} tree through
 * the shared {@link useFileExplorerStore} command bridge; the show-hidden
 * toggle reads and writes that same store.
 *
 * @module features/file-explorer/ui/FileExplorerActions
 */
export function FileExplorerActions() {
  const cwd = useAppStore((s) => s.selectedCwd);
  const showHidden = useFileExplorerStore((s) => s.showHidden);
  const setShowHidden = useFileExplorerStore((s) => s.setShowHidden);
  const commands = useFileExplorerStore((s) => s.commands);

  // No working directory → the tree shows an empty-state; no toolbar to offer.
  if (!cwd) return null;

  return (
    <>
      <WorkspaceBadge cwd={cwd} />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="New File"
        title="New File"
        onClick={() => commands?.newFile()}
      >
        <FilePlus className="text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="New Folder"
        title="New Folder"
        onClick={() => commands?.newFolder()}
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
        onClick={() => commands?.refresh()}
      >
        <RefreshCw className="text-muted-foreground" />
      </Button>
    </>
  );
}
