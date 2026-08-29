/**
 * The one control that decides whether the plumbing shows.
 *
 * On by default and shared by every explorer header, because "hide the
 * machinery" is a preference about how a person likes to read a directory, not
 * about which directory they are reading. The preference itself lives in the
 * feature store and is persisted globally, which is why this component takes no
 * props at all.
 *
 * @module features/file-explorer/ui/HiddenEntriesToggle
 */
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useFileExplorerStore } from '../model/file-explorer-store';

/** Show or hide dotfiles and the plumbing directories. */
export function HiddenEntriesToggle() {
  const showHidden = useFileExplorerStore((s) => s.showHidden);
  const setShowHidden = useFileExplorerStore((s) => s.setShowHidden);
  const label = showHidden ? 'Hide hidden files' : 'Show hidden files';

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      onClick={() => setShowHidden(!showHidden)}
    >
      {showHidden ? (
        <Eye className="text-muted-foreground" />
      ) : (
        <EyeOff className="text-muted-foreground" />
      )}
    </Button>
  );
}
