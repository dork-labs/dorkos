import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowUp, Clipboard, Check, ExternalLink } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { TIMING } from '@/layers/shared/lib/constants';
import { Popover, PopoverTrigger, PopoverContent } from '@/layers/shared/ui';
import { isNewer, isFeatureUpdate } from '../lib/version-compare';

interface VersionItemProps {
  version: string;
  latestVersion: string | null;
  isDevMode?: boolean;
  isDismissed?: boolean;
  onDismiss?: (version: string) => void;
}

const UPDATE_COMMAND = 'npm update -g dorkos';
const RELEASES_URL_BASE = 'https://github.com/dork-labs/dorkos/releases/tag/v';

/**
 * Status bar version badge with two-tier update indicator and popover card.
 *
 * Shows an amber `DEV` badge when `isDevMode` is true (running from source).
 * Shows `v{version}` when up to date. For patches, shows `v{latest} available`
 * with a subtle amber dot. For feature updates, shows `Upgrade available` with
 * an animated amber dot and accent color text.
 */
export function VersionItem({
  version,
  latestVersion,
  isDevMode,
  isDismissed,
  onDismiss,
}: VersionItemProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(UPDATE_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
  }, []);

  // Dev mode: render DEV badge — no update checks
  if (isDevMode) {
    return (
      <span
        className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-amber-600 dark:text-amber-400"
        aria-label="Development build"
      >
        DEV
      </span>
    );
  }

  const hasUpdate = latestVersion !== null && isNewer(latestVersion, version);
  const isFeature = hasUpdate && isFeatureUpdate(latestVersion!, version);

  // No update or dismissed: show plain version
  if (!hasUpdate || isDismissed) {
    return (
      <span
        className="text-muted-foreground cursor-default text-xs"
        aria-label={`Version ${version}`}
      >
        v{version}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 text-xs',
            isFeature ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
          )}
          aria-label={
            isFeature
              ? `Feature update available: v${latestVersion}`
              : `Patch update available: v${latestVersion}`
          }
        >
          <AmberDot pulse={isFeature} />
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={isFeature ? 'feature' : 'patch'}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {isFeature ? 'Upgrade available' : `v${latestVersion} available`}
            </motion.span>
          </AnimatePresence>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-64 p-0">
        <div className="space-y-3 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ArrowUp className="size-4" />
            Update Available
          </div>

          <div className="text-muted-foreground text-xs">
            v{version}
            <span className="mx-1.5">&rarr;</span>v{latestVersion}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="bg-muted hover:bg-muted/80 flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left font-mono text-[11px] transition-colors"
            aria-label="Copy update command"
          >
            <span>{UPDATE_COMMAND}</span>
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.span
                  key="check"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.15 }}
                >
                  <Check className="size-3.5 text-emerald-500" />
                </motion.span>
              ) : (
                <motion.span
                  key="clipboard"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.15 }}
                >
                  <Clipboard className="text-muted-foreground size-3.5" />
                </motion.span>
              )}
            </AnimatePresence>
          </button>

          {isFeature && (
            <a
              href={`${RELEASES_URL_BASE}${latestVersion}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
            >
              What&apos;s new
              <ExternalLink className="size-3" />
            </a>
          )}

          <button
            type="button"
            onClick={() => onDismiss?.(latestVersion!)}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Dismiss this version
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AmberDot({ pulse }: { pulse: boolean }) {
  return (
    <motion.span
      className="inline-block size-1 rounded-full bg-amber-500"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, scale: pulse ? [1, 1.4, 1] : 1 }}
      transition={
        pulse
          ? { opacity: { duration: 0.2 }, scale: { duration: 0.6, ease: 'easeOut' } }
          : { duration: 0.2 }
      }
      aria-hidden="true"
    />
  );
}
