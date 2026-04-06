import type { ServerConfig } from '@dorkos/shared/types';
import { cn, useCopyFeedback } from '@/layers/shared/lib';
import { isNewer } from '@/layers/features/status';

interface ServerTabProps {
  config: ServerConfig | undefined;
  isLoading: boolean;
}

/** Settings panel tab displaying server status, environment, and endpoints. */
export function ServerTab({ config, isLoading }: ServerTabProps) {
  return (
    <div className="space-y-3">
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between py-1">
              <div className="bg-muted animate-tasks h-4 w-24 rounded" />
              <div className="bg-muted animate-tasks h-4 w-16 rounded" />
            </div>
          ))}
        </div>
      ) : config ? (
        <div className="space-y-1">
          {config.isDevMode ? (
            <div className="-mx-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950/30">
              <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                Development Build
              </span>
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
                Running from source — version checks disabled
              </p>
            </div>
          ) : (
            <>
              <ConfigRow label="Version" value={config.version} />

              {/* Update notice — shown when latestVersion is newer */}
              {config.latestVersion && isNewer(config.latestVersion, config.version) && (
                <div className="-mx-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950/30">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                      Update available: v{config.latestVersion}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
                    Run{' '}
                    <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[10px] dark:bg-amber-900/50">
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
          <ConfigRow label="API URL" value={`http://localhost:${config.port}`} mono />
          <ConfigRow label="MCP Endpoint" value={`http://localhost:${config.port}/mcp`} mono />
          <ConfigRow label="Working Directory" value={config.workingDirectory} mono truncate />
          <ConfigRow label="Data Directory" value={config.dorkHome} mono truncate />
          <ConfigRow label="Boundary" value={config.boundary} mono truncate />
          <ConfigRow label="Node.js" value={config.nodeVersion} />
        </div>
      ) : null}
    </div>
  );
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
  const [copied, copy] = useCopyFeedback();
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
