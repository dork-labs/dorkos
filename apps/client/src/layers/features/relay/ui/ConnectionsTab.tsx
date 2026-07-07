import { useState } from 'react';
import { Plug2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Skeleton, Button } from '@/layers/shared/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/layers/shared/ui/alert-dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/layers/shared/ui/sheet';
import { useAdapterCatalog, useToggleAdapter, useRemoveAdapter } from '@/layers/entities/relay';
import { useCreateBinding, useUpdateBinding, useDeleteBinding } from '@/layers/entities/binding';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { getAgentDisplayName } from '@/layers/shared/lib';
import type { AdapterBinding, AdapterManifest } from '@dorkos/shared/relay-schemas';
import {
  BindingDialog,
  toCreateBindingRequest,
  toUpdateBindingRequest,
  type BindingFormValues,
} from '@/layers/features/mesh/ui/BindingDialog';
import { AdapterCard } from './adapter/AdapterCard';
import { AdapterEventLog } from './AdapterEventLog';
import { CatalogCard } from './CatalogCard';
import { AdapterSetupWizard } from './AdapterSetupWizard';
import { useAdapterCardDialogs } from '../model/use-adapter-card-dialogs';

interface WizardState {
  open: boolean;
  manifest?: AdapterManifest;
  instanceId?: string;
}

interface ConnectionsTabProps {
  enabled: boolean;
}

/** Renders active channel instances and available channel types from the catalog. */
export function ConnectionsTab({ enabled }: ConnectionsTabProps) {
  const { data: catalog = [], isLoading } = useAdapterCatalog(enabled);
  const { data: agentsData } = useRegisteredAgents();
  const { mutate: toggleAdapter } = useToggleAdapter();
  const { mutate: removeAdapter } = useRemoveAdapter();
  const createBinding = useCreateBinding();
  const updateBinding = useUpdateBinding();
  const deleteBinding = useDeleteBinding();
  const [wizardState, setWizardState] = useState<WizardState>({ open: false });
  const queryClient = useQueryClient();
  const dialogs = useAdapterCardDialogs();

  // Resolve the adapter manifest for the binding dialog from catalog data.
  function lookupAdapterManifest(adapterId: string) {
    return catalog
      .flatMap((e) => e.instances.map((i) => ({ instance: i, manifest: e.manifest })))
      .find((x) => x.instance.id === adapterId)?.manifest;
  }

  // Resolve the agent display name for the binding dialog from the mesh registry.
  function lookupAgentName(agentId: string) {
    const agent = agentsData?.agents.find((a) => a.id === agentId);
    return agent ? getAgentDisplayName(agent) : agentId;
  }

  async function handleBindingConfirm(values: BindingFormValues) {
    const target = dialogs.bindingTarget;
    if (!target) return;
    try {
      if (target.mode === 'edit' && target.binding) {
        await updateBinding.mutateAsync({
          id: target.binding.id,
          updates: toUpdateBindingRequest(values),
        });
        toast.success('Binding updated');
      } else {
        await createBinding.mutateAsync(toCreateBindingRequest(values));
        toast.success('Binding created');
      }
      dialogs.closeBinding();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save binding');
    }
  }

  async function handleBindingDelete(bindingId: string) {
    try {
      await deleteBinding.mutateAsync(bindingId);
      toast.success('Binding deleted');
      dialogs.closeBinding();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete binding');
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6 p-4">
        <div className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
          >
            {[1, 2].map((i) => (
              <div key={i} className="rounded-lg border p-4">
                <Skeleton className="mb-2 h-5 w-24" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="mt-3 h-8 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Configured: entries that have at least one instance — flatten to individual cards.
  const configuredCards = catalog.flatMap((entry) =>
    entry.instances.map((inst) => ({ instance: inst, manifest: entry.manifest }))
  );

  // Available: non-deprecated entries with no instances, OR multiInstance entries (can always add more).
  // Deprecated adapters are hidden from the catalog but existing instances continue working.
  const availableEntries = catalog.filter(
    (entry) =>
      !entry.manifest.deprecated && (entry.instances.length === 0 || entry.manifest.multiInstance)
  );

  const openWizardForAdd = (manifest: AdapterManifest) => {
    setWizardState({ open: true, manifest });
  };

  const openWizardForConfigure = (manifest: AdapterManifest, instanceId: string) => {
    setWizardState({ open: true, manifest, instanceId });
  };

  // Find the existing instance data for edit mode in the wizard.
  const existingInstance = wizardState.instanceId
    ? catalog.flatMap((e) => e.instances).find((inst) => inst.id === wizardState.instanceId)
    : undefined;

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['relay', 'adapters', 'catalog'] });
  };

  // Resolve binding dialog initial values from the binding target.
  const bindingDialogInitialValues = (binding: AdapterBinding) => ({
    adapterId: binding.adapterId,
    agentId: binding.agentId,
    sessionStrategy: binding.sessionStrategy,
    label: binding.label ?? '',
    permissionMode: binding.permissionMode,
    chatId: binding.chatId,
    channelType: binding.channelType,
    canInitiate: binding.canInitiate,
    canReply: binding.canReply,
    canReceive: binding.canReceive,
  });

  return (
    <div className="space-y-6 p-4">
      {/* Active Channels */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Active Channels
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            className="size-7 p-0"
            aria-label="Refresh channel catalog"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        {configuredCards.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-8">
            <Plug2 className="text-muted-foreground/40 size-8" />
            <div className="text-center">
              <p className="text-muted-foreground text-sm">No channels active</p>
              <p className="text-muted-foreground/60 text-xs">
                Add a channel below to connect agents to external services
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {configuredCards.map(({ instance, manifest }) => (
              <AdapterCard
                key={instance.id}
                instance={instance}
                manifest={manifest}
                onToggle={(newEnabled) => toggleAdapter({ id: instance.id, enabled: newEnabled })}
                onConfigure={() => openWizardForConfigure(manifest, instance.id)}
                onShowEvents={(instanceId) => dialogs.openEvents(instanceId)}
                onEditBinding={(binding) => dialogs.openBindingEdit(binding.adapterId, binding)}
                onRemoveConfirm={(instanceId, name) => dialogs.openRemove(instanceId, name)}
                onAddBinding={(instanceId) => dialogs.openBindingCreate(instanceId)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Add Channel */}
      <section>
        <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Add Channel
        </h3>
        {availableEntries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            All channel types are active. Multi-instance channels like Webhook can be added again
            from the active list.
          </p>
        ) : (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
          >
            {availableEntries.map((entry) => (
              <CatalogCard
                key={entry.manifest.type}
                manifest={entry.manifest}
                onAdd={() => openWizardForAdd(entry.manifest)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Setup Wizard */}
      {wizardState.manifest && (
        <AdapterSetupWizard
          open={wizardState.open}
          onOpenChange={(open) => {
            if (!open) setWizardState({ open: false });
          }}
          manifest={wizardState.manifest}
          existingInstance={existingInstance}
          existingAdapterIds={catalog.flatMap((e) => e.instances.map((i) => i.id))}
        />
      )}

      {/* Remove Confirmation Dialog */}
      {dialogs.removeTarget && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) dialogs.closeRemove();
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove adapter</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to remove &quot;{dialogs.removeTarget.name}&quot;? This will
                stop the adapter and remove its configuration. Messages to its subjects will no
                longer be delivered.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  removeAdapter(dialogs.removeTarget!.instanceId);
                  dialogs.closeRemove();
                }}
                className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Events Sheet */}
      {dialogs.eventsTarget && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) dialogs.closeEvents();
          }}
        >
          <SheetContent className="flex flex-col sm:max-w-md">
            <SheetHeader>
              <SheetTitle>Events</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-hidden">
              <AdapterEventLog adapterId={dialogs.eventsTarget.instanceId} />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Binding Dialog — create (pre-filled with the source adapter) or edit */}
      {dialogs.bindingTarget && (
        <BindingDialog
          open
          onOpenChange={(open) => {
            if (!open) dialogs.closeBinding();
          }}
          mode={dialogs.bindingTarget.mode}
          initialValues={
            dialogs.bindingTarget.binding
              ? bindingDialogInitialValues(dialogs.bindingTarget.binding)
              : { adapterId: dialogs.bindingTarget.adapterId }
          }
          adapterName={lookupAdapterManifest(dialogs.bindingTarget.adapterId)?.displayName}
          agentName={
            dialogs.bindingTarget.binding
              ? lookupAgentName(dialogs.bindingTarget.binding.agentId)
              : undefined
          }
          onConfirm={handleBindingConfirm}
          onDelete={dialogs.bindingTarget.mode === 'edit' ? handleBindingDelete : undefined}
          bindingId={dialogs.bindingTarget.binding?.id}
          isPending={createBinding.isPending || updateBinding.isPending || deleteBinding.isPending}
        />
      )}
    </div>
  );
}
