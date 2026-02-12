import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '../../contexts/TransportContext';
import { useAppStore, type RecentCwd } from '../../stores/app-store';
import { useDirectoryState } from '../../hooks/use-directory-state';
import { PathBreadcrumb } from '../ui/path-breadcrumb';
import { formatRelativeTime } from '../../lib/session-utils';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '../ui/responsive-dialog';
import {
  Folder,
  FolderOpen,
  Eye,
  EyeOff,
  Clock,
  Loader2,
} from 'lucide-react';

type PickerView = 'browse' | 'recent';

function getInitialView(recentCwds: RecentCwd[], selectedCwd: string | null): PickerView {
  if (recentCwds.length === 0) return 'browse';
  if (recentCwds.length === 1 && recentCwds[0].path === selectedCwd) return 'browse';
  try {
    const raw = localStorage.getItem('gateway-picker-view');
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
}

export function DirectoryPicker({ open, onOpenChange }: DirectoryPickerProps) {
  const transport = useTransport();
  const [selectedCwd, setSelectedCwd] = useDirectoryState();
  const { recentCwds } = useAppStore();
  const [currentPath, setCurrentPath] = useState(selectedCwd || '');
  const [showHidden, setShowHidden] = useState(false);
  const [view, setView] = useState<PickerView>(() => getInitialView(recentCwds, selectedCwd));

  const onClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  const { data, isLoading } = useQuery({
    queryKey: ['directory', currentPath, showHidden],
    queryFn: () => transport.browseDirectory(currentPath || undefined, showHidden),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  const handleSelect = useCallback(() => {
    if (data?.path) {
      setSelectedCwd(data.path);
      onClose();
    }
  }, [data?.path, setSelectedCwd, onClose]);

  const handleViewChange = useCallback((v: PickerView) => {
    setView(v);
    try {
      localStorage.setItem('gateway-picker-view', JSON.stringify({ view: v, timestamp: new Date().toISOString() }));
    } catch {}
  }, []);

  const handleNavigate = useCallback((dirPath: string) => {
    setCurrentPath(dirPath);
    setView('browse');
  }, []);

  const handleRecentSelect = useCallback(
    (dirPath: string) => {
      setSelectedCwd(dirPath);
      onClose();
    },
    [setSelectedCwd, onClose],
  );

  const toggleBtn = (active: boolean, position: 'left' | 'right') =>
    `p-1.5 transition-colors ${
      position === 'left' ? 'rounded-l-md' : 'rounded-r-md'
    } ${
      active
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground/40 hover:text-muted-foreground'
    }`;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="p-0 gap-0 max-w-lg overflow-hidden sm:rounded-xl">
        {/* Header */}
        <ResponsiveDialogHeader className="px-4 py-3 border-b space-y-0">
          <ResponsiveDialogTitle className="text-sm font-medium">
            Select Working Directory
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        {/* Navigation bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 overflow-x-auto">
          <div className="flex items-center border rounded-md flex-shrink-0">
            {recentCwds.length > 0 && (
              <button
                onClick={() => handleViewChange('recent')}
                className={toggleBtn(view === 'recent', 'left')}
                aria-label="Recent directories"
                title="Recent"
              >
                <Clock className="size-[--size-icon-sm]" />
              </button>
            )}
            <button
              onClick={() => { handleViewChange('browse'); handleNavigate(''); }}
              className={toggleBtn(view === 'browse', recentCwds.length > 0 ? 'right' : 'left')}
              aria-label="Browse directories"
              title="Browse"
            >
              <Folder className="size-[--size-icon-sm]" />
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
                className="p-1 max-md:p-2 rounded hover:bg-accent transition-colors flex-shrink-0"
                aria-label={showHidden ? 'Hide hidden folders' : 'Show hidden folders'}
                title={showHidden ? 'Hide hidden folders' : 'Show hidden folders'}
              >
                {showHidden ? (
                  <Eye className="size-[--size-icon-sm] text-muted-foreground" />
                ) : (
                  <EyeOff className="size-[--size-icon-sm] text-muted-foreground" />
                )}
              </button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground px-1">Recent</span>
          )}
        </div>

        {/* Content area */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === 'browse' ? (
            <>
              {isLoading && !data ? (
                <div className="flex items-center justify-center h-20">
                  <Loader2 className="size-[--size-icon-md] animate-spin text-muted-foreground" />
                </div>
              ) : data?.entries.length === 0 ? (
                <div className="flex items-center justify-center h-20">
                  <p className="text-xs text-muted-foreground/60">No subdirectories</p>
                </div>
              ) : (
                <div className="py-1">
                  {data?.parent && (
                    <button
                      onClick={() => handleNavigate(data.parent!)}
                      className="flex items-center gap-2 w-full px-4 py-1.5 text-left hover:bg-accent transition-colors"
                    >
                      <Folder className="size-[--size-icon-md] text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">..</span>
                    </button>
                  )}
                  {data?.entries.map((entry) => (
                    <button
                      key={entry.path}
                      onClick={() => handleNavigate(entry.path)}
                      className="flex items-center gap-2 w-full px-4 py-1.5 text-left hover:bg-accent transition-colors"
                    >
                      <FolderOpen className="size-[--size-icon-md] text-muted-foreground" />
                      <span className="text-sm truncate">{entry.name}</span>
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
                  className="flex items-center gap-2 w-full px-4 py-1.5 text-left hover:bg-accent transition-colors"
                >
                  <Folder className="size-[--size-icon-md] text-muted-foreground flex-shrink-0" />
                  <span className="text-sm text-muted-foreground truncate">
                    {recent.path.replace(/^\/Users\/[^/]+/, '~')}
                  </span>
                  <span className="ml-auto text-[11px] text-muted-foreground/50 flex-shrink-0">
                    {formatRelativeTime(recent.accessedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t bg-muted/20">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSelect}
            disabled={!data?.path || view !== 'browse'}
            className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            Select
          </button>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
