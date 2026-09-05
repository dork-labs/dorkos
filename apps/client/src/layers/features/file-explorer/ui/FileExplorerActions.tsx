import { FilePlus, FolderPlus, RefreshCw } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { useFileExplorerStore } from '../model/file-explorer-store';
import { HiddenEntriesToggle } from './HiddenEntriesToggle';
import { WorkspaceBadge } from './WorkspaceBadge';

/**
 * Files-panel header toolbar: New file, New folder, Show/Hide hidden, Refresh,
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
  const commands = useFileExplorerStore((s) => s.commands);

  // No working directory → the tree shows an empty-state; no toolbar to offer.
  if (!cwd) return null;

  return (
    <>
      <WorkspaceBadge cwd={cwd} />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="New file"
        title="New file"
        onClick={() => commands?.newFile()}
      >
        <FilePlus className="text-muted-foreground" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="New folder"
        title="New folder"
        onClick={() => commands?.newFolder()}
      >
        <FolderPlus className="text-muted-foreground" />
      </Button>
      <HiddenEntriesToggle />
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
