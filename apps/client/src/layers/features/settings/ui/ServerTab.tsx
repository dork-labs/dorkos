import { useState, useCallback } from 'react';
import type { ServerConfig } from '@dorkos/shared/types';
import { cn, TIMING } from '@/layers/shared/lib';
import { isNewer } from '@/layers/features/status';

interface ServerTabProps {
  config: ServerConfig | undefined;
  isLoading: boolean;
  onOpenTunnelDialog?: () => void;
}

/** Settings panel tab displaying server status, version, and tunnel controls. */
export function ServerTab({ config, isLoading, onOpenTunnelDialog }: ServerTabProps) {
  return (
    <div className="space-y-3">
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between py-1">
              <div className="bg-muted h-4 w-24 animate-pulse rounded" />
              <div className="bg-muted h-4 w-16 animate-pulse rounded" />
            </div>
          ))}
        </div>
      ) : config ? (
        <div className="space-y-1">
          {config.isDevMode ? (
            <div className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 -mx-1 rounded border px-2 py-1.5">
              <span className="text-amber-800 dark:text-amber-200 text-sm font-medium">
                Development Build
              </span>
              <p className="text-amber-700 dark:text-amber-300 mt-0.5 text-xs">
                Running from source — version checks disabled
              </p>
            </div>
          ) : (
            <>
              <ConfigRow label="Version" value={config.version} />

              {/* Update notice — shown when latestVersion is newer */}
              {config.latestVersion && isNewer(config.latestVersion, config.version) && (
                <div className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 -mx-1 rounded border px-2 py-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-amber-800 dark:text-amber-200 text-sm font-medium">
                      Update available: v{config.latestVersion}
                    </span>
                  </div>
                  <p className="text-amber-700 dark:text-amber-300 mt-0.5 text-xs">
                    Run{' '}
                    <code className="bg-amber-100 dark:bg-amber-900/50 rounded px-1 py-0.5 font-mono text-[10px]">
                      npm update -g dorkos
                    </code>{' '}
                    to update
                  </p>
                </div>
              )}
            </>
          )}

          <ConfigRow label="Port" value={String(config.port)} />
          <ConfigRow label="Uptime" value={formatUptime(config.uptime)} />
          <ConfigRow
            label="Working Directory"
            value={config.workingDirectory}
            mono
            truncate
          />
          <ConfigRow label="Node.js" value={config.nodeVersion} />
          <ConfigRow
            label="Claude CLI"
            value={config.claudeCliPath || 'Not found'}
            mono
            truncate
            muted={!config.claudeCliPath}
          />

          <div className="hover:bg-muted/50 -mx-1 flex items-center justify-between rounded px-1 py-1">
            <span className="text-muted-foreground text-sm">Tunnel</span>
            <button
              onClick={onOpenTunnelDialog}
              className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-2.5 py-1 text-xs font-medium shadow-sm transition-colors"
            >
              Manage
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
    });
  }, []);
  return { copied, copy };
}

function ConfigRow({
  label,
  value,
  mono,
  truncate,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  muted?: boolean;
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className="hover:bg-muted/50 active:bg-muted/70 -mx-1 flex w-full items-center justify-between gap-4 rounded px-1 py-1 transition-colors duration-100"
    >
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      {copied ? (
        <span className="text-muted-foreground text-xs">Copied</span>
      ) : (
        <span
          className={cn(
            'text-right text-sm',
            mono && 'font-mono',
            truncate && 'max-w-48 min-w-0 truncate',
            muted && 'text-muted-foreground'
          )}
          dir={truncate ? 'rtl' : undefined}
          title={value}
        >
          {value}
        </span>
      )}
    </button>
  );
}


function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
