import { useState, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger, Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { AdapterManifest, AdapterStatus, CatalogEntry } from '@dorkos/shared/relay-schemas';

interface ChannelPickerProps {
  /** Pre-filtered external adapter catalog (no `category: 'internal'` entries). */
  catalog: CatalogEntry[];
  /** Adapter IDs already bound to this agent (shown as "connected" in the picker). */
  boundAdapterIds: Set<string>;
  /** Called when the user selects an existing adapter instance to bind. */
  onSelectChannel: (adapterId: string) => void;
  /** Called when the user picks an adapter type to configure from scratch. */
  onRequestSetup: (manifest: AdapterManifest) => void;
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
 * Popover listing all configured relay channel instances for binding to an agent,
 * plus unconfigured adapter types available to set up.
 *
 * Receives a pre-filtered catalog as a prop (no internal data fetching).
 * Shows a status dot, adapter name, optional label, and connection state for each
 * configured channel. A second section lists adapter types available for fresh setup.
 */
export function ChannelPicker({
  catalog,
  boundAdapterIds,
  onSelectChannel,
  onRequestSetup,
  disabled,
}: ChannelPickerProps) {
  const [open, setOpen] = useState(false);

  const configuredChannels: ChannelItem[] = useMemo(
    () =>
      catalog.flatMap((entry) =>
        entry.instances.map((inst) => ({
          id: inst.id,
          displayName: inst.status.displayName ?? entry.manifest.displayName,
          label: inst.label,
          state: inst.status.state,
          isDisabled: inst.status.state === 'error' || !inst.enabled,
          alreadyBound: boundAdapterIds.has(inst.id),
        }))
      ),
    [catalog, boundAdapterIds]
  );

  const availableToSetup = useMemo(
    () =>
      catalog.filter(
        (entry) =>
          !entry.manifest.deprecated &&
          (entry.instances.length === 0 || entry.manifest.multiInstance)
      ),
    [catalog]
  );

  function handleSelect(adapterId: string) {
    onSelectChannel(adapterId);
    setOpen(false);
  }

  function handleSetup(manifest: AdapterManifest) {
    setOpen(false);
    onRequestSetup(manifest);
  }

  const isEmpty = configuredChannels.length === 0 && availableToSetup.length === 0;

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
          {isEmpty ? (
            <div className="px-3 py-4 text-center">
              <p className="text-muted-foreground text-sm">No channels available</p>
            </div>
          ) : (
            <>
              {/* Configured instances */}
              {configuredChannels.length > 0 && (
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
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          STATE_DOT_CLASS[channel.state]
                        )}
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

              {/* Available to set up */}
              {availableToSetup.length > 0 && (
                <>
                  <div className="border-t" />
                  <div className="py-1">
                    <p className="text-muted-foreground px-3 py-1 text-xs font-medium">
                      Available to set up
                    </p>
                    {availableToSetup.map((entry) => (
                      <button
                        key={entry.manifest.type}
                        onClick={() => handleSetup(entry.manifest)}
                        className={cn(
                          'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                          'hover:bg-accent'
                        )}
                      >
                        <Plus className="size-3.5 shrink-0" />
                        <span className="truncate font-medium">{entry.manifest.displayName}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
