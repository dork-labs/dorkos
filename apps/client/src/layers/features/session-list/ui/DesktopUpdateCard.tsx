import { motion } from 'motion/react';
import { ArrowUp, Download, RotateCw } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

/** The updater states this card renders — the sidebar only mounts it for these. */
type DesktopUpdateCardStatus = Extract<
  DesktopUpdateStatus,
  { state: 'downloading' | 'downloaded' }
>;

interface DesktopUpdateCardProps {
  status: DesktopUpdateCardStatus;
  onRestart: () => void;
}

/**
 * Sidebar footer card reflecting the desktop app's native updater.
 *
 * The desktop counterpart to {@link SidebarUpgradeCard}: instead of an
 * `npm update` command (which updates the CLI, not the running app), it shows
 * the native updater's progress and, once an update is downloaded, a button
 * that restarts the app to install it. Shares the web card's visual language.
 */
export function DesktopUpdateCard({ status, onRestart }: DesktopUpdateCardProps) {
  const isReady = status.state === 'downloaded';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2 }}
      className={cn(
        'mx-2 mb-1 rounded-md border p-3',
        isReady ? 'border-amber-500/20 bg-amber-500/5' : 'border-border bg-muted/50'
      )}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        {isReady ? <ArrowUp className="size-3.5" /> : <Download className="size-3.5" />}
        <span>{isReady ? `Update ready — v${status.version}` : 'Downloading update…'}</span>
      </div>

      <p className="text-muted-foreground mt-1 text-xs">
        {isReady ? 'Restart to finish updating' : 'DorkOS is downloading the latest version'}
      </p>

      {isReady && (
        <div className="mt-2.5 flex items-center">
          <button
            type="button"
            onClick={onRestart}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
            aria-label="Restart to install the update"
          >
            <RotateCw className="size-3" />
            Restart to install
          </button>
        </div>
      )}
    </motion.div>
  );
}
