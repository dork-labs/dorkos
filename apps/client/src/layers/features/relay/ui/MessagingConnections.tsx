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
import {
  BindingDialog,
  MoveChatDialog,
  readChatConflict,
  toCreateBindingRequest,
  toUpdateBindingRequest,
  type BindingFormValues,
  type ChatConflict,
  useCreateBinding,
  useUpdateBinding,
  useDeleteBinding,
} from '@/layers/entities/binding';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { getAgentDisplayName } from '@/layers/shared/lib';
import type { AdapterBinding, AdapterManifest } from '@dorkos/shared/relay-schemas';
import { AdapterCard } from './adapter/AdapterCard';
import { BindingBridgeSection } from './BindingBridgeSection';
import { AdapterEventLog } from './AdapterEventLog';
import { CatalogCard } from './CatalogCard';
import { AdapterSetupWizard } from './AdapterSetupWizard';
import { useAdapterCardDialogs } from '../model/use-adapter-card-dialogs';

interface WizardState {
  open: boolean;
  manifest?: AdapterManifest;
  instanceId?: string;
}

interface MessagingConnectionsProps {
  enabled: boolean;
}

/**
 * The messaging half of the Connections page: the ways people and platforms
 * reach your agents, plus the ones you could add.
 *
 * Each live connection lists the agents it reaches and opens its own history;
 * adding one runs the agent-first wizard. A chat goes to exactly one agent, so
 * pointing a chat at someone new is offered as a move rather than refused.
 */
export function MessagingConnections({ enabled }: MessagingConnectionsProps) {
  const { data: catalog = [], isLoading } = useAdapterCatalog(enabled);
  const { data: agentsData } = useRegisteredAgents();
  const { mutate: toggleAdapter } = useToggleAdapter();
  const { mutate: removeAdapter } = useRemoveAdapter();
  // A chat conflict is a question, not a failure — `handleBindingConfirm`
  // below tells the two apart and shows a dialog for the former, so the
  // shared mutation toast has to stay out of it entirely rather than firing
  // underneath that dialog.
  const createBinding = useCreateBinding({ suppressErrorToast: true });
  const updateBinding = useUpdateBinding({ suppressErrorToast: true });
  const deleteBinding = useDeleteBinding();
  const [wizardState, setWizardState] = useState<WizardState>({ open: false });
  const [conflict, setConflict] = useState<ChatConflict | null>(null);
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
        toast.success('Saved');
      } else {
        await createBinding.mutateAsync(toCreateBindingRequest(values));
        toast.success('Connected');
      }
      dialogs.closeBinding();
    } catch (err) {
      // A chat that already reaches someone is not an error to apologise for —
      // it is a question. Ask it, naming who has the chat today.
      const found = readChatConflict(err, {
        id: values.agentId,
        name: lookupAgentName(values.agentId),
      });
      if (found) {
        setConflict(found);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Couldn't save that");
    }
  }

  async function handleBindingDelete(bindingId: string) {
    try {
      await deleteBinding.mutateAsync(bindingId);
      toast.success('Removed');
      dialogs.closeBinding();
    } catch {
      // Reported by the shared mutation toast (`useDeleteBinding`'s
      // `meta.errorLabel`).
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
      {/* The ways people already reach your agents. */}
      <section aria-labelledby="messaging-live">
        <div className="mb-2 flex items-center justify-between">
          <h3 id="messaging-live" className="text-sm font-semibold">
            Live now
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            className="size-7 p-0"
            aria-label="Check for new ways to connect"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        {configuredCards.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-8">
            <Plug2 className="text-muted-foreground/40 size-8" />
            <div className="text-center">
              <p className="text-muted-foreground text-sm">Nothing reaches your agents yet</p>
              <p className="text-muted-foreground/60 text-xs">
                Pick one below to start messaging them from somewhere else
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

      {/* The ways you could add. */}
      <section aria-labelledby="messaging-add">
        <h3 id="messaging-add" className="mb-2 text-sm font-semibold">
          Add a way to reach them
        </h3>
        {availableEntries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            You are using every kind there is. Some, like Webhook, can be added more than once from
            the list above.
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
              <AlertDialogTitle>Remove this connection?</AlertDialogTitle>
              <AlertDialogDescription>
                &quot;{dialogs.removeTarget.name}&quot; will stop working and its settings are
                deleted. Messages sent to it after that reach nobody.
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
              <SheetTitle>What happened here</SheetTitle>
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
          bridged={dialogs.bindingTarget.binding?.bridge === 'room'}
          bridgeSlot={
            dialogs.bindingTarget.binding ? (
              <BindingBridgeSection
                binding={dialogs.bindingTarget.binding}
                onDone={() => dialogs.closeBinding()}
              />
            ) : undefined
          }
        />
      )}

      <MoveChatDialog
        conflict={conflict}
        onClose={() => setConflict(null)}
        onMoved={() => dialogs.closeBinding()}
      />
    </div>
  );
}
