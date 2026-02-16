import { useState, useCallback } from 'react';
import type { ServerConfig } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui';

interface ServerTabProps {
  config: ServerConfig | undefined;
  isLoading: boolean;
}

export function ServerTab({ config, isLoading }: ServerTabProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-foreground text-sm font-semibold">Server</h3>

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
          <ConfigRow label="Version" value={config.version} />
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

          <ConfigBadgeRow
            label="Tunnel"
            value={config.tunnel.enabled ? 'Enabled' : 'Disabled'}
            variant={config.tunnel.enabled ? 'default' : 'secondary'}
          />

          {config.tunnel.enabled && (
            <>
              <ConfigBadgeRow
                label="Tunnel Status"
                value={config.tunnel.connected ? 'Connected' : 'Disconnected'}
                variant={config.tunnel.connected ? 'default' : 'secondary'}
              />

              {config.tunnel.url && (
                <ConfigRow label="Tunnel URL" value={config.tunnel.url} mono />
              )}

              <ConfigRow
                label="Tunnel Auth"
                value={config.tunnel.authEnabled ? 'Enabled' : 'Disabled'}
              />

              <ConfigBadgeRow
                label="ngrok Token"
                value={config.tunnel.tokenConfigured ? 'Configured' : 'Not configured'}
                variant={config.tunnel.tokenConfigured ? 'default' : 'secondary'}
              />
            </>
          )}
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
      setTimeout(() => setCopied(false), 1500);
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

function ConfigBadgeRow({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant: 'default' | 'secondary';
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className="hover:bg-muted/50 active:bg-muted/70 -mx-1 flex w-full items-center justify-between rounded px-1 py-1 transition-colors duration-100"
    >
      <span className="text-muted-foreground text-sm">{label}</span>
      {copied ? (
        <span className="text-muted-foreground text-xs">Copied</span>
      ) : (
        <Badge variant={variant}>{value}</Badge>
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
