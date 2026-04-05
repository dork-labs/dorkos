import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger, Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';
import type { AdapterStatus } from '@dorkos/shared/relay-schemas';

interface ChannelPickerProps {
  /** Called when the user selects a channel to bind. Receives the adapter instance ID. */
  onSelectChannel: (adapterId: string) => void;
  /** Called when the user clicks "Set up a new channel" to navigate to Settings. */
  onSetupNewChannel: () => void;
  /** Adapter IDs already bound to this agent (to show as "already connected"). */
  boundAdapterIds: Set<string>;
  /** Whether the popover trigger button is disabled. */
  disabled?: boolean;
}

interface ChannelItem {
  id: string;
  displayName: string;
  label: string | undefined;
  state: AdapterStatus['state'];
  isDisabled: boolean;
  alreadyBound: boolean;
}

const STATE_DOT_CLASS: Record<AdapterStatus['state'], string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-amber-500',
  error: 'bg-red-500',
  starting: 'bg-amber-400',
  stopping: 'bg-amber-400',
  reconnecting: 'bg-amber-400',
};

/**
 * Popover listing all configured relay channel instances for binding to an agent.
 *
 * Shows a status dot, adapter name, optional label, and connection state for each
 * channel. Disabled or errored channels are shown but not clickable. Channels already
 * bound to the agent are shown as "connected" and are non-interactive. A footer link
 * navigates to Settings for new channel setup.
 */
export function ChannelPicker({
  onSelectChannel,
  onSetupNewChannel,
  boundAdapterIds,
  disabled,
}: ChannelPickerProps) {
  const relayEnabled = useRelayEnabled();
  const { data: catalog = [] } = useAdapterCatalog(relayEnabled);
  const [open, setOpen] = useState(false);

  const configuredChannels: ChannelItem[] = catalog.flatMap((entry) =>
    entry.instances.map((inst) => ({
      id: inst.id,
      displayName: inst.status.displayName ?? entry.manifest.displayName,
      label: inst.label,
      state: inst.status.state,
      isDisabled: inst.status.state === 'error' || !inst.enabled,
      alreadyBound: boundAdapterIds.has(inst.id),
    }))
  );

  function handleSelect(adapterId: string) {
    onSelectChannel(adapterId);
    setOpen(false);
  }

  function handleSetupNewChannel() {
    setOpen(false);
    onSetupNewChannel();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Plus className="mr-1.5 size-3.5" />
          Connect to Channel
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="max-h-64 overflow-y-auto">
          {configuredChannels.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-muted-foreground text-sm">No channels configured</p>
            </div>
          ) : (
            <div className="py-1">
              {configuredChannels.map((channel) => (
                <button
                  key={channel.id}
                  disabled={channel.isDisabled || channel.alreadyBound}
                  onClick={() => handleSelect(channel.id)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                    'hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                >
                  <span
                    className={cn('size-2 shrink-0 rounded-full', STATE_DOT_CLASS[channel.state])}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{channel.displayName}</p>
                    {channel.label && (
                      <p className="text-muted-foreground truncate text-xs">{channel.label}</p>
                    )}
                  </div>
                  <span className="text-muted-foreground/60 text-xs">
                    {channel.alreadyBound ? 'connected' : channel.state}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Footer: navigate to Settings to configure a new channel */}
        <div className="border-t px-3 py-2">
          <button
            onClick={handleSetupNewChannel}
            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-left text-xs transition-colors"
          >
            <Plus className="size-3" />
            Set up a new channel...
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
