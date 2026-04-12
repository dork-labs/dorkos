import { useState, useCallback, useMemo } from 'react';
import { Plug2, Radio } from 'lucide-react';
import { toast } from 'sonner';
import {
  useBindings,
  useCreateBinding,
  useDeleteBinding,
  useTestBinding,
  useUpdateBinding,
} from '@/layers/entities/binding';
import { useExternalAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';
import { BindingDialog, type BindingFormValues } from '@/layers/features/mesh/ui/BindingDialog';
import { AdapterSetupWizard } from '@/layers/features/relay';
import { useAppStore } from '@/layers/shared/model';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AdapterBinding, AdapterManifest } from '@dorkos/shared/relay-schemas';
import { BoundChannelRow } from './BoundChannelRow';
import { ChannelPicker } from './ChannelPicker';

interface ChannelsTabProps {
  /** The agent whose channel bindings are displayed and managed. */
  agent: AgentManifest;
}

/** Display fields derived from a catalog entry for a bound adapter instance. */
interface AdapterDisplay {
  state: 'connected' | 'disconnected' | 'error' | 'connecting';
  name: string;
  iconId?: string;
  adapterType: string;
  errorMessage?: string;
}

interface EditDialogState {
  open: boolean;
  binding: AdapterBinding | null;
  adapterName: string;
}

interface WizardState {
  open: boolean;
  manifest?: AdapterManifest;
}

const CLOSED_EDIT_DIALOG: EditDialogState = { open: false, binding: null, adapterName: '' };
const CLOSED_WIZARD: WizardState = { open: false };

/**
 * Channels tab in the Agent dialog.
 *
 * Lists all relay bindings for the agent, lets the user add new bindings via
 * the ChannelPicker, opens the BindingDialog for editing existing bindings,
 * and renders AdapterSetupWizard inline for configuring new adapter types.
 */
export function ChannelsTab({ agent }: ChannelsTabProps) {
  const relayEnabled = useRelayEnabled();
  const { data: allBindings = [] } = useBindings();
  const { data: externalCatalog = [] } = useExternalAdapterCatalog(relayEnabled);
  const createBinding = useCreateBinding();
  const deleteBinding = useDeleteBinding();
  const testBinding = useTestBinding();
  const updateBinding = useUpdateBinding();
  const openSettingsToTab = useAppStore((s) => s.openSettingsToTab);

  const [editDialog, setEditDialog] = useState<EditDialogState>(CLOSED_EDIT_DIALOG);
  const [wizardState, setWizardState] = useState<WizardState>(CLOSED_WIZARD);

  const agentBindings = allBindings.filter((b) => b.agentId === agent.id);

  const adapterDisplayByInstanceId = useMemo(() => {
    const map = new Map<string, AdapterDisplay>();
    for (const entry of externalCatalog) {
      for (const inst of entry.instances) {
        const raw = inst.status.state;
        const state: AdapterDisplay['state'] =
          raw === 'connected' || raw === 'error'
            ? raw
            : raw === 'starting' || raw === 'stopping' || raw === 'reconnecting'
              ? 'connecting'
              : 'disconnected';
        map.set(inst.id, {
          state,
          name: inst.status.displayName ?? entry.manifest.displayName,
          iconId: entry.manifest.iconId,
          adapterType: entry.manifest.type,
          errorMessage: inst.status.lastError ?? undefined,
        });
      }
    }
    return map;
  }, [externalCatalog]);

  const resolveAdapterDisplay = useCallback(
    (adapterId: string): AdapterDisplay =>
      adapterDisplayByInstanceId.get(adapterId) ?? {
        state: 'disconnected',
        name: adapterId,
        adapterType: adapterId,
      },
    [adapterDisplayByInstanceId]
  );

  const boundAdapterIds = useMemo(
    () => new Set(agentBindings.map((b) => b.adapterId)),
    [agentBindings]
  );

  const handleSelectChannel = useCallback(
    async (adapterId: string) => {
      try {
        await createBinding.mutateAsync({
          adapterId,
          agentId: agent.id,
          sessionStrategy: 'per-chat',
          label: '',
          canInitiate: false,
          canReply: true,
          canReceive: true,
        });
        toast.success('Channel connected');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to connect channel');
      }
    },
    [agent.id, createBinding]
  );

  const handleRequestSetup = useCallback((manifest: AdapterManifest) => {
    setWizardState({ open: true, manifest });
  }, []);

  const handleEdit = useCallback(
    (binding: AdapterBinding) => {
      setEditDialog({
        open: true,
        binding,
        adapterName: resolveAdapterDisplay(binding.adapterId).name,
      });
    },
    [resolveAdapterDisplay]
  );

  const handleRemove = useCallback(
    async (bindingId: string) => {
      try {
        await deleteBinding.mutateAsync(bindingId);
        toast.success('Channel removed');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove channel');
      }
    },
    [deleteBinding]
  );

  const handleTogglePause = useCallback(
    async (bindingId: string, enabled: boolean) => {
      try {
        await updateBinding.mutateAsync({ id: bindingId, updates: { enabled } });
        toast.success(enabled ? 'Channel resumed' : 'Channel paused');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update channel');
      }
    },
    [updateBinding]
  );

  const handleTest = useCallback(
    async (bindingId: string) => {
      try {
        const result = await testBinding.mutateAsync(bindingId);
        if (result.ok) {
          toast.success(`Test OK \u2014 routed in ${result.latencyMs}ms`);
        } else {
          toast.error(`Test failed: ${result.reason ?? 'unknown error'}`);
        }
        return result;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Test failed');
        throw err;
      }
    },
    [testBinding]
  );

  const handleEditConfirm = useCallback(
    async (values: BindingFormValues) => {
      if (!editDialog.binding) return;
      try {
        await updateBinding.mutateAsync({
          id: editDialog.binding.id,
          updates: {
            sessionStrategy: values.sessionStrategy,
            label: values.label,
            chatId: values.chatId,
            channelType: values.channelType,
            canInitiate: values.canInitiate,
            canReply: values.canReply,
            canReceive: values.canReceive,
          },
        });
        toast.success('Binding updated');
        setEditDialog(CLOSED_EDIT_DIALOG);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update binding');
      }
    },
    [editDialog.binding, updateBinding]
  );

  const handleEditDelete = useCallback(
    async (bindingId: string) => {
      try {
        await deleteBinding.mutateAsync(bindingId);
        toast.success('Channel removed');
        setEditDialog(CLOSED_EDIT_DIALOG);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove channel');
      }
    },
    [deleteBinding]
  );

  // Shared dialogs — rendered in all states so wizard/edit state is preserved
  // if the component re-renders into a different state while they are open.
  const dialogs = (
    <>
      {editDialog.binding && (
        <BindingDialog
          open={editDialog.open}
          onOpenChange={(open) => {
            if (!open) setEditDialog(CLOSED_EDIT_DIALOG);
          }}
          mode="edit"
          initialValues={{
            adapterId: editDialog.binding.adapterId,
            agentId: editDialog.binding.agentId,
            sessionStrategy: editDialog.binding.sessionStrategy,
            label: editDialog.binding.label,
            chatId: editDialog.binding.chatId,
            channelType: editDialog.binding.channelType,
            canInitiate: editDialog.binding.canInitiate,
            canReply: editDialog.binding.canReply,
            canReceive: editDialog.binding.canReceive,
          }}
          adapterName={editDialog.adapterName}
          agentName={getAgentDisplayName(agent)}
          bindingId={editDialog.binding.id}
          onConfirm={handleEditConfirm}
          onDelete={handleEditDelete}
          isPending={updateBinding.isPending || deleteBinding.isPending}
        />
      )}
      {wizardState.manifest && (
        <AdapterSetupWizard
          open={wizardState.open}
          onOpenChange={(open) => {
            if (!open) setWizardState(CLOSED_WIZARD);
          }}
          manifest={wizardState.manifest}
          existingAdapterIds={externalCatalog.flatMap((e) => e.instances.map((i) => i.id))}
        />
      )}
    </>
  );

  // State A: relay bus is off
  if (!relayEnabled) {
    return (
      <>
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10">
          <Plug2 className="text-muted-foreground/40 size-8" />
          <div className="space-y-1 text-center">
            <p className="text-sm font-medium">The Relay message bus is off</p>
            <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">
              Channels connect this agent to external messaging platforms. Enable Relay in Settings
              to get started.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => openSettingsToTab('advanced')}>
            Open Relay settings
          </Button>
        </div>
        {dialogs}
      </>
    );
  }

  // State B: relay on but no external adapters configured
  if (externalCatalog.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10">
          <Radio className="text-muted-foreground/40 size-8" />
          <div className="space-y-1 text-center">
            <p className="text-sm font-medium">No channels available</p>
            <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">
              To connect this agent to Telegram, Slack, or a webhook, first configure a channel in
              Settings. It will appear here as soon as it&apos;s ready.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => openSettingsToTab('channels')}>
            Configure a channel
          </Button>
        </div>
        {dialogs}
      </>
    );
  }

  // State C: relay on, adapters exist, no bindings for this agent
  if (agentBindings.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10">
          <Radio className="text-muted-foreground/40 size-8" />
          <div className="space-y-1 text-center">
            <p className="text-sm font-medium">Let this agent reach the outside world</p>
            <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">
              Connect Telegram, Slack, or a webhook so this agent can send and receive messages
              while you are away.
            </p>
          </div>
          <ChannelPicker
            catalog={externalCatalog}
            boundAdapterIds={boundAdapterIds}
            onSelectChannel={handleSelectChannel}
            onRequestSetup={handleRequestSetup}
            disabled={createBinding.isPending}
          />
        </div>
        {dialogs}
      </>
    );
  }

  // State D: bindings exist — standard list with picker below
  return (
    <div className="space-y-4">
      {/* Binding list */}
      <div className="space-y-2">
        {agentBindings.map((binding) => {
          const display = resolveAdapterDisplay(binding.adapterId);
          return (
            <BoundChannelRow
              key={binding.id}
              binding={binding}
              channelName={display.name}
              channelIconId={display.iconId}
              channelAdapterType={display.adapterType}
              adapterState={display.state}
              errorMessage={display.errorMessage}
              onTogglePause={(enabled) => handleTogglePause(binding.id, enabled)}
              onTest={() => handleTest(binding.id)}
              onEdit={() => handleEdit(binding)}
              onRemove={() => handleRemove(binding.id)}
            />
          );
        })}
      </div>

      {/* Add channel picker */}
      <ChannelPicker
        catalog={externalCatalog}
        boundAdapterIds={boundAdapterIds}
        onSelectChannel={handleSelectChannel}
        onRequestSetup={handleRequestSetup}
        disabled={createBinding.isPending}
      />

      {dialogs}
    </div>
  );
}
