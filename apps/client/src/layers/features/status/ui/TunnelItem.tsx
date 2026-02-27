import { useState } from 'react';
import { Globe } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { TunnelDialog } from '@/layers/features/settings';
import type { ServerConfig } from '@dorkos/shared/types';

interface TunnelItemProps {
  tunnel: ServerConfig['tunnel'];
}

export function TunnelItem({ tunnel }: TunnelItemProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const hostname = tunnel.url ? new URL(tunnel.url).hostname : null;

  return (
    <>
      <button
        onClick={() => setDialogOpen(true)}
        className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150"
        aria-label={tunnel.connected ? `Remote connected: ${hostname}` : 'Remote disconnected'}
        title={tunnel.connected ? `Remote: ${tunnel.url}` : 'Remote: disconnected'}
      >
        <Globe
          className={cn(
            'size-(--size-icon-xs)',
            tunnel.connected ? 'text-green-500 animate-pulse' : '',
          )}
        />
        {tunnel.connected && hostname && (
          <span className="max-w-24 truncate">{hostname}</span>
        )}
        {!tunnel.connected && <span>Remote</span>}
      </button>
      <TunnelDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
