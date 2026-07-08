import { useMemo } from 'react';
import { toast } from 'sonner';
import { cn } from '@/layers/shared/lib';
import type {
  AdapterBinding,
  AdapterManifest,
  CatalogInstance,
} from '@dorkos/shared/relay-schemas';
import { useBindings, useCreateBinding } from '@/layers/entities/binding';
import { ADAPTER_STATE_DOT_CLASS } from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { AdapterCardHeader } from './AdapterCardHeader';
import { AdapterCardBindings } from './AdapterCardBindings';
import { AdapterCardError } from './AdapterCardError';

interface AdapterCardProps {
  instance: CatalogInstance;
  manifest: AdapterManifest;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
  onShowEvents: (instanceId: string) => void;
  onEditBinding: (binding: AdapterBinding) => void;
  onRemoveConfirm: (instanceId: string, name: string) => void;
  onAddBinding: (instanceId: string, adapterId: string) => void;
}

/** Displays a configured adapter instance — delegates rendering to sub-components. */
export function AdapterCard({
  instance,
  manifest,
  onToggle,
  onConfigure,
  onShowEvents,
  onEditBinding,
  onRemoveConfirm,
  onAddBinding,
}: AdapterCardProps) {
  const createBinding = useCreateBinding();

  const isBuiltinClaude = manifest.type === 'claude-code' && manifest.builtin;

  // Prefer custom label as primary display name, fall back to status displayName or id.
  const primaryName = instance.label || instance.status.displayName || instance.id;
  // When a custom label exists, show the manifest type name as secondary context.
  const secondaryName = instance.label ? instance.status.displayName || manifest.displayName : null;

  const { data: allBindings = [] } = useBindings();
  const { data: agentsData } = useRegisteredAgents();

  const agents = useMemo(() => agentsData?.agents ?? [], [agentsData?.agents]);
  const totalAgentCount = agents.length;

  const adapterBindings = useMemo(
    () => allBindings.filter((b) => b.adapterId === instance.id),
    [allBindings, instance.id]
  );

  const boundAgentRows = useMemo(() => {
    return adapterBindings.map((b) => {
      const agent = agents.find((a) => a.id === b.agentId);
      return {
        bindingId: b.id,
        agentName: agent?.name ?? b.agentId,
        sessionStrategy: b.sessionStrategy,
        chatId: b.chatId,
        channelType: b.channelType,
        canInitiate: b.canInitiate,
        canReply: b.canReply,
        canReceive: b.canReceive,
        binding: b,
      };
    });
  }, [adapterBindings, agents]);

  const hasBindings = adapterBindings.length > 0;
  const isConnected = instance.status.state === 'connected';
  // CCA is always considered "bound" — it serves all agents
  const effectiveHasBindings = isBuiltinClaude || hasBindings;

  // Status dot color from the canonical adapter-state palette, with one overlay:
  // connected-but-serving-no-agents warrants attention, so it goes amber.
  const statusDotClass = cn(
    'size-2 shrink-0 rounded-full',
    instance.status.state === 'connected' && !effectiveHasBindings
      ? 'bg-amber-500 motion-safe:animate-pulse'
      : (ADAPTER_STATE_DOT_CLASS[instance.status.state] ?? 'bg-muted-foreground')
  );

  async function handleQuickBind(agentId: string) {
    try {
      await createBinding.mutateAsync({
        adapterId: instance.id,
        agentId,
        sessionStrategy: 'per-chat',
        label: '',
      });
      toast.success('Channel connected');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to connect channel');
    }
  }

  return (
    <div
      className={cn(
        'shadow-soft hover:shadow-elevated rounded-xl border p-5 transition-shadow',
        isBuiltinClaude && 'border-dashed'
      )}
    >
      <AdapterCardHeader
        manifest={manifest}
        instance={instance}
        primaryName={primaryName}
        secondaryName={secondaryName}
        statusDotClass={statusDotClass}
        onToggle={onToggle}
        onShowEvents={() => onShowEvents(instance.id)}
        onConfigure={onConfigure}
        onRemove={() => onRemoveConfirm(instance.id, primaryName)}
        onAddBinding={() => onAddBinding(instance.id, instance.id)}
        isBuiltinClaude={isBuiltinClaude}
      />
      <AdapterCardBindings
        instance={instance}
        isBuiltinClaude={isBuiltinClaude}
        boundAgentRows={boundAgentRows}
        totalAgentCount={totalAgentCount}
        isConnected={isConnected}
        hasBindings={hasBindings}
        onEditBinding={(binding) => onEditBinding(binding)}
        onQuickBind={handleQuickBind}
        onAdvancedBind={() => onAddBinding(instance.id, instance.id)}
        createBindingPending={createBinding.isPending}
      />
      <AdapterCardError instance={instance} />
    </div>
  );
}
