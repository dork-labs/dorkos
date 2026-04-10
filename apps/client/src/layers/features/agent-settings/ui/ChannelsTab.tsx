import { useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  useBindings,
  useCreateBinding,
  useDeleteBinding,
  useUpdateBinding,
} from '@/layers/entities/binding';
import { useExternalAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';
import { BindingDialog, type BindingFormValues } from '@/layers/features/mesh/ui/BindingDialog';
import { AdapterSetupWizard } from '@/layers/features/relay';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AdapterBinding, AdapterManifest } from '@dorkos/shared/relay-schemas';
import { ChannelBindingCard } from './ChannelBindingCard';
import { ChannelPicker } from './ChannelPicker';

interface ChannelsTabProps {
  /** The agent whose channel bindings are displayed and managed. */
  agent: AgentManifest;
}

/** Display fields derived from a catalog entry for a bound adapter instance. */
interface AdapterDisplay {
  state: 'connected' | 'disconnected' | 'error';
  name: string;
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
  const updateBinding = useUpdateBinding();

  const [editDialog, setEditDialog] = useState<EditDialogState>(CLOSED_EDIT_DIALOG);
  const [wizardState, setWizardState] = useState<WizardState>(CLOSED_WIZARD);

  const agentBindings = allBindings.filter((b) => b.agentId === agent.id);

  const adapterDisplayByInstanceId = useMemo(() => {
    const map = new Map<string, AdapterDisplay>();
    for (const entry of externalCatalog) {
      for (const inst of entry.instances) {
        const raw = inst.status.state;
        const state: AdapterDisplay['state'] =
          raw === 'connected' || raw === 'error' ? raw : 'disconnected';
        map.set(inst.id, {
          state,
          name: inst.status.displayName ?? entry.manifest.displayName,
          errorMessage: inst.status.lastError ?? undefined,
        });
      }
    }
    return map;
  }, [externalCatalog]);

  const resolveAdapterDisplay = useCallback(
    (adapterId: string): AdapterDisplay =>
      adapterDisplayByInstanceId.get(adapterId) ?? { state: 'disconnected', name: adapterId },
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
          {agentBindings.map((binding) => {
            const display = resolveAdapterDisplay(binding.adapterId);
            return (
              <ChannelBindingCard
                key={binding.id}
                binding={binding}
                channelName={display.name}
                adapterState={display.state}
                errorMessage={display.errorMessage}
                onEdit={() => handleEdit(binding)}
                onRemove={() => handleRemove(binding.id)}
              />
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground py-2 text-sm">
          {relayEnabled ? 'No channels connected.' : 'Relay is not enabled.'}
        </p>
      )}

      {/* Add channel picker */}
      <ChannelPicker
        catalog={externalCatalog}
        boundAdapterIds={boundAdapterIds}
        onSelectChannel={handleSelectChannel}
        onRequestSetup={handleRequestSetup}
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

      {/* Inline setup wizard — opens on top of the AgentDialog */}
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
    </div>
  );
}
