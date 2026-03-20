import { useState } from 'react';
import { Globe } from 'lucide-react';
import { cn, getPlatform } from '@/layers/shared/lib';
import { useTunnelStatus } from '@/layers/entities/tunnel';
import { TunnelDialog } from '@/layers/features/settings';
import type { ServerConfig } from '@dorkos/shared/types';

interface TunnelItemProps {
  tunnel: ServerConfig['tunnel'];
}

/** Status bar item showing tunnel connection state with colored quality dot. */
export function TunnelItem({ tunnel: tunnelProp }: TunnelItemProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: liveStatus } = useTunnelStatus();

  if (getPlatform().isEmbedded) return null;

  // Prefer live status from TanStack Query, fall back to prop
  const tunnel = liveStatus ?? tunnelProp;
  const hostname = tunnel.url ? new URL(tunnel.url).hostname : null;

  const dotColor = tunnel.connected ? 'bg-green-500' : 'bg-gray-400';

  return (
    <>
      <button
        onClick={() => setDialogOpen(true)}
        className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150"
        aria-label={tunnel.connected ? `Remote connected: ${hostname}` : 'Remote disconnected'}
        title={tunnel.connected ? `Remote: ${tunnel.url}` : 'Remote: disconnected'}
      >
        <span className="relative">
          <Globe className="size-(--size-icon-xs)" />
          <span
            className={cn(
              'absolute -top-0.5 -right-0.5 size-1.5 rounded-full transition-colors duration-300',
              dotColor
            )}
          />
        </span>
        {tunnel.connected && hostname && <span className="max-w-24 truncate">{hostname}</span>}
        {!tunnel.connected && <span>Remote</span>}
      </button>
      <TunnelDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
