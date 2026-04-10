import { Settings } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Button, Switch } from '@/layers/shared/ui';
import { AdapterIcon, ADAPTER_STATE_DOT_CLASS } from '@/layers/features/relay';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

interface ChannelSettingRowProps {
  /** The catalog instance representing a configured channel. */
  instance: CatalogInstance;
  /** The manifest for the adapter type — provides display name and icon. */
  manifest: AdapterManifest;
  /** Number of agent bindings using this channel instance. */
  bindingCount?: number;
  /** Called when the enabled toggle is changed. */
  onToggle: (enabled: boolean) => void;
  /** Called when the Configure button is clicked. */
  onConfigure: () => void;
}

/** Derives Tailwind classes for the status indicator dot from the instance state. */
function resolveStatusDotClass(instance: CatalogInstance): string {
  const dotColor = ADAPTER_STATE_DOT_CLASS[instance.status.state] ?? 'bg-muted-foreground';
  return cn('size-2 shrink-0 rounded-full', dotColor);
}

/**
 * Compact row for the Settings Channels tab — shows status dot, adapter icon,
 * channel name, enabled toggle, and a configure action.
 */
export function ChannelSettingRow({
  instance,
  manifest,
  bindingCount,
  onToggle,
  onConfigure,
}: ChannelSettingRowProps) {
  const displayName = instance.label || instance.status.displayName || instance.id;
  const statusDotClass = resolveStatusDotClass(instance);
  const { inbound, outbound } = instance.status.messageCount;
  const totalMessages = inbound + outbound;

  return (
    <div className="flex items-center gap-3 py-2">
      {/* Status indicator */}
      <div className={statusDotClass} aria-hidden />

      {/* Adapter icon */}
      <AdapterIcon
        iconId={manifest.iconId}
        adapterType={manifest.type}
        size={16}
        className="text-muted-foreground shrink-0"
      />

      {/* Name + metadata */}
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium">{displayName}</span>
        <p className="text-muted-foreground/60 text-xs">
          {bindingCount !== undefined && bindingCount > 0
            ? `${bindingCount} agent${bindingCount !== 1 ? 's' : ''}`
            : 'No agents'}
          {totalMessages > 0 && ` · ${totalMessages} messages`}
        </p>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={instance.enabled}
          onCheckedChange={onToggle}
          aria-label={`${displayName} enabled`}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={onConfigure}
          className="size-7 p-0"
          aria-label={`Configure ${displayName}`}
        >
          <Settings className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
