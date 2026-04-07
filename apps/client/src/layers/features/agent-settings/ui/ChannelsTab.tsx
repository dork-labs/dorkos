import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  useBindings,
  useCreateBinding,
  useDeleteBinding,
  useUpdateBinding,
} from '@/layers/entities/binding';
import { useAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';
import { useAgentDialogDeepLink, useSettingsDeepLink } from '@/layers/shared/model';
import { BindingDialog, type BindingFormValues } from '@/layers/features/mesh/ui/BindingDialog';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { ChannelBindingCard } from './ChannelBindingCard';
import { ChannelPicker } from './ChannelPicker';

interface ChannelsTabProps {
  /** The agent whose channel bindings are displayed and managed. */
  agent: AgentManifest;
}

/** State for the edit binding dialog. */
interface EditDialogState {
  open: boolean;
  binding: AdapterBinding | null;
  adapterName: string;
}

const CLOSED_EDIT_DIALOG: EditDialogState = { open: false, binding: null, adapterName: '' };

/**
 * Channels tab in the Agent dialog.
 *
 * Lists all relay bindings for the agent, lets the user add new bindings via
 * the ChannelPicker, and opens the BindingDialog for editing existing bindings.
 */
export function ChannelsTab({ agent }: ChannelsTabProps) {
  const relayEnabled = useRelayEnabled();
  const { data: allBindings = [] } = useBindings();
  const { data: catalog = [] } = useAdapterCatalog(relayEnabled);
  const createBinding = useCreateBinding();
  const deleteBinding = useDeleteBinding();
  const updateBinding = useUpdateBinding();
  const { close: closeAgentDialog } = useAgentDialogDeepLink();
  const { open: openSettings } = useSettingsDeepLink();

  const [editDialog, setEditDialog] = useState<EditDialogState>(CLOSED_EDIT_DIALOG);

  const agentBindings = allBindings.filter((b) => b.agentId === agent.id);

  // Build a flat lookup: adapterId → { displayName, state, errorMessage }
  const adapterStatusByInstanceId = new Map(
    catalog.flatMap((entry) =>
      entry.instances.map((inst) => [
        inst.id,
        {
          displayName: inst.status.displayName ?? entry.manifest.displayName,
          state: inst.status.state as 'connected' | 'disconnected' | 'error',
          errorMessage: inst.status.lastError,
        },
      ])
    )
  );

  const boundAdapterIds = new Set(agentBindings.map((b) => b.adapterId));

  function resolveAdapterState(adapterId: string): 'connected' | 'disconnected' | 'error' {
    const status = adapterStatusByInstanceId.get(adapterId);
    if (!status) return 'disconnected';
    // Normalize transient states (starting, stopping, reconnecting) to disconnected for display.
    if (status.state === 'connected' || status.state === 'error') return status.state;
    return 'disconnected';
  }

  function resolveAdapterName(adapterId: string): string {
    return adapterStatusByInstanceId.get(adapterId)?.displayName ?? adapterId;
  }

  function resolveErrorMessage(adapterId: string): string | undefined {
    const status = adapterStatusByInstanceId.get(adapterId);
    return status?.errorMessage ?? undefined;
  }

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

  const handleSetupNewChannel = useCallback(() => {
    // Close the agent dialog, then navigate to Settings → Channels.
    closeAgentDialog();
    openSettings('channels');
  }, [closeAgentDialog, openSettings]);

  const handleEdit = useCallback(
    (binding: AdapterBinding) => {
      setEditDialog({
        open: true,
        binding,
        adapterName:
          adapterStatusByInstanceId.get(binding.adapterId)?.displayName ?? binding.adapterId,
      });
    },
    [catalog, adapterStatusByInstanceId]
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

  return (
    <div className="space-y-4">
      {/* Binding list */}
      {agentBindings.length > 0 ? (
        <div className="space-y-2">
          {agentBindings.map((binding) => (
            <ChannelBindingCard
              key={binding.id}
              binding={binding}
              channelName={resolveAdapterName(binding.adapterId)}
              adapterState={resolveAdapterState(binding.adapterId)}
              errorMessage={resolveErrorMessage(binding.adapterId)}
              onEdit={() => handleEdit(binding)}
              onRemove={() => handleRemove(binding.id)}
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground py-2 text-sm">
          {relayEnabled ? 'No channels connected.' : 'Relay is not enabled.'}
        </p>
      )}

      {/* Add channel picker */}
      <ChannelPicker
        onSelectChannel={handleSelectChannel}
        onSetupNewChannel={handleSetupNewChannel}
        boundAdapterIds={boundAdapterIds}
        disabled={!relayEnabled || createBinding.isPending}
      />

      {/* Edit binding dialog */}
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
          agentName={agent.name}
          bindingId={editDialog.binding.id}
          onConfirm={handleEditConfirm}
          onDelete={handleEditDelete}
          isPending={updateBinding.isPending || deleteBinding.isPending}
        />
      )}
    </div>
  );
}
