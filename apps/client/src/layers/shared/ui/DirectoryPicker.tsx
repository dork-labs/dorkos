import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore, type RecentCwd } from '@/layers/shared/model';
import { formatRelativeTime, shortenHomePath, STORAGE_KEYS } from '@/layers/shared/lib';
import { PathBreadcrumb } from './path-breadcrumb';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from './responsive-dialog';
import { Folder, FolderOpen, Eye, EyeOff, Clock, Loader2 } from 'lucide-react';

type PickerView = 'browse' | 'recent';

function getInitialView(recentCwds: RecentCwd[], selectedCwd: string | null): PickerView {
  if (recentCwds.length === 0) return 'browse';
  if (recentCwds.length === 1 && recentCwds[0].path === selectedCwd) return 'browse';
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PICKER_VIEW);
    if (raw) {
      const pref = JSON.parse(raw) as { view: PickerView; timestamp: string };
      const age = Date.now() - new Date(pref.timestamp).getTime();
      if (age < 8 * 60 * 60 * 1000) return pref.view;
    }
  } catch {}
  return 'recent';
}

interface DirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Callback invoked when a directory is selected. */
  onSelect: (path: string) => void;
  /** Initial path to browse from. Falls back to home directory when omitted. */
  initialPath?: string | null;
}

export function DirectoryPicker({ open, onOpenChange, onSelect, initialPath }: DirectoryPickerProps) {
  const transport = useTransport();
  const { recentCwds } = useAppStore();
  const [currentPath, setCurrentPath] = useState(initialPath || '');
  const [showHidden, setShowHidden] = useState(false);
  const [view, setView] = useState<PickerView>(() => getInitialView(recentCwds, initialPath ?? null));

  const onClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  const { data, isLoading } = useQuery({
    queryKey: ['directory', currentPath, showHidden],
    queryFn: () => transport.browseDirectory(currentPath || undefined, showHidden),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- Semantic clarity
  const handleSelect = useCallback(() => {
    if (data?.path) {
      onSelect(data.path);
      onClose();
    }
  }, [data?.path, onSelect, onClose]);

  const handleViewChange = useCallback((v: PickerView) => {
    setView(v);
    try {
      localStorage.setItem(
        STORAGE_KEYS.PICKER_VIEW,
        JSON.stringify({ view: v, timestamp: new Date().toISOString() })
      );
    } catch {}
  }, []);

  const handleNavigate = useCallback((dirPath: string) => {
    setCurrentPath(dirPath);
    setView('browse');
  }, []);

  const handleRecentSelect = useCallback(
    (dirPath: string) => {
      onSelect(dirPath);
      onClose();
    },
    [onSelect, onClose]
  );

  const toggleBtn = (active: boolean, position: 'left' | 'right') =>
    `p-1.5 transition-colors ${position === 'left' ? 'rounded-l-md' : 'rounded-r-md'} ${
      active ? 'bg-accent text-foreground' : 'text-muted-foreground/40 hover:text-muted-foreground'
    }`;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-w-lg gap-0 overflow-hidden p-0 sm:rounded-xl">
        {/* Header */}
        <ResponsiveDialogHeader className="space-y-0 border-b px-4 py-3">
          <ResponsiveDialogTitle className="text-sm font-medium">
            Select Working Directory
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        {/* Navigation bar */}
        <div className="bg-muted/30 flex items-center gap-2 overflow-x-auto border-b px-4 py-2">
          <div className="flex flex-shrink-0 items-center rounded-md border">
            {recentCwds.length > 0 && (
              <button
                onClick={() => handleViewChange('recent')}
                className={toggleBtn(view === 'recent', 'left')}
                aria-label="Recent directories"
                title="Recent"
              >
                <Clock className="size-(--size-icon-sm)" />
              </button>
            )}
            <button
              onClick={() => {
                handleViewChange('browse');
                handleNavigate('');
              }}
              className={toggleBtn(view === 'browse', recentCwds.length > 0 ? 'right' : 'left')}
              aria-label="Browse directories"
              title="Browse"
            >
              <Folder className="size-(--size-icon-sm)" />
            </button>
          </div>

          {view === 'browse' ? (
            <>
              <PathBreadcrumb
                path={data?.path ?? null}
                maxSegments={5}
                onSegmentClick={handleNavigate}
                size="md"
              />
              <div className="flex-1" />
              <button
                onClick={() => setShowHidden(!showHidden)}
                className="hover:bg-accent flex-shrink-0 rounded p-1 transition-colors max-md:p-2"
                aria-label={showHidden ? 'Hide hidden folders' : 'Show hidden folders'}
                title={showHidden ? 'Hide hidden folders' : 'Show hidden folders'}
              >
                {showHidden ? (
                  <Eye className="text-muted-foreground size-(--size-icon-sm)" />
                ) : (
                  <EyeOff className="text-muted-foreground size-(--size-icon-sm)" />
                )}
              </button>
            </>
          ) : (
            <span className="text-muted-foreground px-1 text-xs">Recent</span>
          )}
        </div>

        {/* Content area */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === 'browse' ? (
            <>
              {isLoading && !data ? (
                <div className="flex h-20 items-center justify-center">
                  <Loader2 className="text-muted-foreground size-(--size-icon-md) animate-spin" />
                </div>
              ) : data?.entries.length === 0 ? (
                <div className="flex h-20 items-center justify-center">
                  <p className="text-muted-foreground/60 text-xs">No subdirectories</p>
                </div>
              ) : (
                <div className="py-1">
                  {data?.parent && (
                    <button
                      onClick={() => handleNavigate(data.parent!)}
                      className="hover:bg-accent flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors"
                    >
                      <Folder className="text-muted-foreground size-(--size-icon-md)" />
                      <span className="text-muted-foreground text-sm">..</span>
                    </button>
                  )}
                  {data?.entries.map((entry) => (
                    <button
                      key={entry.path}
                      onClick={() => handleNavigate(entry.path)}
                      className="hover:bg-accent flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors"
                    >
                      <FolderOpen className="text-muted-foreground size-(--size-icon-md)" />
                      <span className="truncate text-sm">{entry.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="py-1">
              {recentCwds.slice(0, 10).map((recent) => (
                <button
                  key={recent.path}
                  onClick={() => handleRecentSelect(recent.path)}
                  className="hover:bg-accent flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors"
                >
                  <Folder className="text-muted-foreground size-(--size-icon-md) flex-shrink-0" />
                  <span className="text-muted-foreground truncate text-sm">
                    {shortenHomePath(recent.path)}
                  </span>
                  <span className="text-muted-foreground/50 ml-auto flex-shrink-0 text-[11px]">
                    {formatRelativeTime(recent.accessedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bg-muted/20 flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            onClick={onClose}
            className="hover:bg-accent rounded-md px-3 py-1.5 text-xs transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSelect}
            disabled={!data?.path || view !== 'browse'}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
          >
            Select
          </button>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
