import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { cn, isNewer, openExternalLink, useCopyFeedback } from '@/layers/shared/lib';
import { Button, CopyButton } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';

/** Settings panel tab displaying server status, environment, and endpoints. */
export function ServerTab() {
  const transport = useTransport();
  const {
    data: config,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });
  return (
    <div className="space-y-3">
      {isError && !config ? (
        <ServerUnreachable
          detail={error instanceof Error ? error.message : null}
          onRetry={() => void refetch()}
          isRetrying={isRefetching}
        />
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between py-1">
              <div className="bg-muted animate-breath h-4 w-24 rounded" />
              <div className="bg-muted animate-breath h-4 w-16 rounded" />
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
                    <code className="text-3xs rounded bg-amber-100 px-1 py-0.5 font-mono dark:bg-amber-900/50">
                      npm update -g dorkos
                    </code>{' '}
                    to update
                  </p>
                </div>
              )}
            </>
          )}

          <ServerAddress port={config.port} />

          <ConfigRow label="Uptime" value={formatUptime(config.uptime)} />
          <ConfigRow label="Working Directory" value={config.workingDirectory} mono truncate />
          <ConfigRow label="Data Directory" value={config.dorkHome} mono truncate />
          <ConfigRow label="Boundary" value={config.boundary} mono truncate />
          <ConfigRow label="Node.js" value={config.nodeVersion} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * What this tab shows when it cannot reach the server.
 *
 * This panel is now the only place to find your address, so someone whose
 * server is mid-restart after a crash opens it precisely when it has nothing to
 * report. Going blank there tells them nothing and looks like a broken screen;
 * saying so, with the server's own words and a way to try again, at least
 * matches what is happening.
 */
function ServerUnreachable({
  detail,
  onRetry,
  isRetrying,
}: {
  detail: string | null;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  return (
    <div className="-mx-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950/30">
      <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
        Can&rsquo;t reach the DorkOS server
      </span>
      <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
        It may be restarting. Give it a moment and try again.
      </p>
      {detail ? (
        <p className="text-3xs mt-1 font-mono break-words text-amber-700/80 dark:text-amber-300/80">
          {detail}
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={onRetry}
        disabled={isRetrying}
        aria-label="Try reaching the server again"
      >
        {isRetrying ? 'Trying…' : 'Try again'}
      </Button>
    </div>
  );
}

/**
 * The address DorkOS is answering on, ready to copy or open.
 *
 * Live rather than assumed: the desktop app asks for 4242 and takes the next
 * free port when something else has it, so the only trustworthy source is the
 * running server's own report. Without this, a desktop user had no way at all
 * to find the URL their MCP clients need.
 */
function ServerAddress({ port }: { port: number }) {
  const baseUrl = `http://localhost:${port}`;
  return (
    <div className="border-border/60 -mx-1 mt-3 mb-3 space-y-2 border-b px-1 pb-3">
      <div>
        <p className="text-sm font-medium">Address</p>
        <p className="text-muted-foreground text-xs">
          Where DorkOS is answering on this computer. Bookmark it, or point another app at it.
        </p>
      </div>
      {/* One grid for both URLs so the controls column is sized by the widest
          row and the two fields end at the same edge — the cockpit address
          carries an extra button, the MCP endpoint does not. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-2">
        <AddressField url={baseUrl} label="DorkOS address">
          <button
            type="button"
            onClick={() => openExternalLink(baseUrl)}
            className="text-muted-foreground hover:text-foreground focus-ring rounded-sm p-1 transition-colors"
            aria-label="Open DorkOS in your browser"
            title="Open in your browser"
          >
            <ExternalLink className="size-3.5" />
          </button>
        </AddressField>
        <p className="text-muted-foreground col-span-2 text-xs">
          Give this one to MCP clients like Claude Code, Cursor, or Windsurf. It is a URL to paste,
          not a page to visit.
        </p>
        <AddressField url={`${baseUrl}/mcp`} label="MCP endpoint" />
      </div>
    </div>
  );
}

/**
 * One copyable URL and its controls, as two cells of the grid above.
 *
 * @param url - The address to show and copy.
 * @param label - What this address is, for the copy button's accessible name.
 * @param children - Extra controls beside the copy button.
 */
function AddressField({
  url,
  label,
  children,
}: {
  url: string;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <code className="bg-muted min-w-0 truncate rounded-md px-3 py-2 font-mono text-xs">
        {url}
      </code>
      <div className="flex items-center gap-1.5">
        <CopyButton value={url} label={`Copy the ${label}`} />
        {children}
      </div>
    </>
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
  const { copied, failed, copy } = useCopyFeedback();

  function content() {
    if (copied) return <span className="text-muted-foreground text-xs">Copied</span>;
    if (failed) return <span className="text-destructive text-xs">Couldn&apos;t copy</span>;
    return (
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
        {/* A truncated value is a path, and a path's leaf is the part worth
            keeping: `dir="rtl"` moves the ellipsis to the front so the shared
            head is what gets clipped. The `bdi` is what keeps the value reading
            left-to-right inside that. Without it a neutral character at
            either edge is claimed by the surrounding RTL paragraph and painted
            at the opposite end: the leading `/` of an absolute path is drawn at
            the right, and a trailing `.` or `-` at the left. (A MATCHED
            `(...)` or `[...]` pair does not move — UBA rule N0 gives it the
            direction of its surrounding strong context — so a path ending in
            `)` is not the reproduction case it looks like; an unpaired `)` is.
            Measured in Chromium, DOR-1686.) Unconditional on purpose — the
            `bdi` and the `dir` belong together, and separating them is what
            caused this. Same idiom as `MessageSearchHitRow`. */}
        <bdi dir="ltr">{value}</bdi>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      className="hover:bg-muted/50 active:bg-muted/70 -mx-1 flex w-full items-center justify-between gap-4 rounded px-1 py-1 transition-colors duration-100"
    >
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      {content()}
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
