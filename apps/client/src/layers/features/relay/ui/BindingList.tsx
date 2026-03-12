import { useState, useMemo, useCallback } from 'react';
import { ArrowRight, Copy, Link2, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
} from '@/layers/shared/ui';
import { useBindings, useCreateBinding, useDeleteBinding, useUpdateBinding } from '@/layers/entities/binding';
import { useAdapterCatalog } from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { BindingDialog, type BindingFormValues } from '@/layers/features/mesh/ui/BindingDialog';
import { STRATEGY_BADGE_LABELS } from '../lib/binding-labels';

/** Resolve adapter display name and icon from the catalog by adapter ID. */
function useAdapterLookup() {
  const { data: catalog = [] } = useAdapterCatalog();
  return useMemo(() => {
    const map = new Map<string, { displayName: string; iconEmoji?: string }>();
    for (const entry of catalog) {
      for (const instance of entry.instances) {
        map.set(instance.id, {
          displayName: instance.status.displayName || entry.manifest.displayName,
          iconEmoji: entry.manifest.iconEmoji,
        });
      }
    }
    return map;
  }, [catalog]);
}

/** Resolve agent display name and icon from the mesh registry by agent ID. */
function useAgentLookup() {
  const { data } = useRegisteredAgents();
  return useMemo(() => {
    const map = new Map<string, { name: string; icon?: string }>();
    for (const agent of data?.agents ?? []) {
      map.set(agent.id, { name: agent.name, icon: agent.icon });
    }
    return map;
  }, [data]);
}

/** Extract a human-readable name from a project path (last segment). */
function projectPathName(projectPath: string): string {
  const segments = projectPath.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || projectPath;
}

interface EditState {
  binding: AdapterBinding;
  adapterName: string;
  agentName: string;
}

/** Structured list of all adapter-agent bindings with edit, duplicate, and delete actions. */
export function BindingList() {
  const { data: bindings = [], isLoading } = useBindings();
  const { mutate: createBinding } = useCreateBinding();
  const { mutate: deleteBinding } = useDeleteBinding();
  const { mutate: updateBinding } = useUpdateBinding();
  const adapterLookup = useAdapterLookup();
  const agentLookup = useAgentLookup();

  const [deleteTarget, setDeleteTarget] = useState<AdapterBinding | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState<AdapterBinding | null>(null);

  const handleDelete = useCallback(
    (binding: AdapterBinding) => {
      deleteBinding(binding.id);
      setDeleteTarget(null);
    },
    [deleteBinding],
  );

  const handleEditConfirm = useCallback(
    (values: BindingFormValues) => {
      if (!editState) return;
      updateBinding({
        id: editState.binding.id,
        updates: {
          sessionStrategy: values.sessionStrategy,
          label: values.label,
          chatId: values.chatId ?? undefined,
          channelType: values.channelType ?? undefined,
        },
      });
      setEditState(null);
    },
    [editState, updateBinding],
  );

  const handleCreateConfirm = useCallback(
    (values: BindingFormValues) => {
      createBinding({
        adapterId: values.adapterId,
        agentId: values.agentId,
        projectPath: values.projectPath,
        sessionStrategy: values.sessionStrategy,
        label: values.label,
        chatId: values.chatId,
        channelType: values.channelType,
      });
      setCreateDialogOpen(false);
    },
    [createBinding],
  );

  const handleDuplicateConfirm = useCallback(
    (values: BindingFormValues) => {
      createBinding({
        adapterId: values.adapterId,
        agentId: values.agentId,
        projectPath: values.projectPath,
        sessionStrategy: values.sessionStrategy,
        label: values.label,
        chatId: values.chatId,
        channelType: values.channelType,
      });
      setDuplicateSource(null);
    },
    [createBinding],
  );

  const handleDuplicate = useCallback((binding: AdapterBinding) => {
    setDuplicateSource(binding);
  }, []);

  /** Header shown above the list (and above the empty state). */
  const listHeader = (
    <div className="flex items-center justify-between px-4 py-2">
      <h3 className="text-sm font-medium text-muted-foreground">Bindings</h3>
      <Button variant="outline" size="sm" onClick={() => setCreateDialogOpen(true)}>
        <Plus className="mr-1.5 size-3.5" />
        New Binding
      </Button>
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <Skeleton className="size-5 rounded" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-24" />
              <div className="flex-1" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (bindings.length === 0) {
    return (
      <>
        {listHeader}
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <Link2 className="size-10 text-muted-foreground/50" />
          <div className="space-y-1">
            <p className="text-sm font-medium">No bindings configured</p>
            <p className="text-sm text-muted-foreground">
              Create your first binding to route messages from adapters to agents.
            </p>
          </div>
        </div>

        {/* Create binding dialog (empty state) */}
        {createDialogOpen && (
          <BindingDialog
            open={true}
            onOpenChange={(open) => { if (!open) setCreateDialogOpen(false); }}
            mode="create"
            onConfirm={handleCreateConfirm}
          />
        )}
      </>
    );
  }

  return (
    <>
      {listHeader}

      <div className="space-y-2 p-4">
        {bindings.map((binding) => {
          const adapter = adapterLookup.get(binding.adapterId);
          const adapterName = adapter?.displayName ?? binding.adapterId;
          const adapterIcon = adapter?.iconEmoji;
          const agent = agentLookup.get(binding.agentId);
          const agentName = agent?.name ?? projectPathName(binding.projectPath);

          return (
            <div
              key={binding.id}
              className="flex items-center justify-between rounded-lg border p-3 transition-shadow hover:shadow-sm"
            >
              {/* Left: adapter -> agent routing info */}
              <div className="flex min-w-0 items-center gap-2">
                {adapterIcon && (
                  <span className="shrink-0 text-sm" role="img" aria-hidden>
                    {adapterIcon}
                  </span>
                )}
                <span className="truncate text-sm font-medium">{adapterName}</span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                {agent?.icon && (
                  <span className="shrink-0 text-sm" role="img" aria-hidden>
                    {agent.icon}
                  </span>
                )}
                <span className="truncate text-sm">{agentName}</span>
              </div>

              {/* Right: badges and actions */}
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {STRATEGY_BADGE_LABELS[binding.sessionStrategy] ?? binding.sessionStrategy}
                </Badge>
                {binding.chatId && (
                  <Badge variant="outline" className="text-xs">
                    {binding.channelType ?? 'chat'}:{binding.chatId}
                  </Badge>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0"
                      aria-label="Binding actions"
                    >
                      <MoreVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => setEditState({ binding, adapterName, agentName })}
                    >
                      <Pencil className="mr-2 size-3.5" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDuplicate(binding)}>
                      <Copy className="mr-2 size-3.5" />
                      Add similar binding
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setDeleteTarget(binding)}
                      className="text-red-600 focus:text-red-600"
                    >
                      <Trash2 className="mr-2 size-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          );
        })}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete binding</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this binding? Messages from the adapter will no
              longer be routed to the agent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit binding dialog */}
      {editState && (
        <BindingDialog
          open={true}
          onOpenChange={(open) => { if (!open) setEditState(null); }}
          adapterName={editState.adapterName}
          agentName={editState.agentName}
          mode="edit"
          initialValues={{
            sessionStrategy: editState.binding.sessionStrategy,
            label: editState.binding.label,
            chatId: editState.binding.chatId,
            channelType: editState.binding.channelType,
          }}
          onConfirm={handleEditConfirm}
        />
      )}

      {/* Create binding dialog */}
      {createDialogOpen && (
        <BindingDialog
          open={true}
          onOpenChange={(open) => { if (!open) setCreateDialogOpen(false); }}
          mode="create"
          onConfirm={handleCreateConfirm}
        />
      )}

      {/* Duplicate binding dialog — pre-fills all fields except chatId */}
      {duplicateSource && (
        <BindingDialog
          open={true}
          onOpenChange={(open) => { if (!open) setDuplicateSource(null); }}
          mode="create"
          initialValues={{
            adapterId: duplicateSource.adapterId,
            agentId: duplicateSource.agentId,
            projectPath: duplicateSource.projectPath,
            sessionStrategy: duplicateSource.sessionStrategy,
            label: duplicateSource.label,
            // chatId intentionally omitted — must differ for the new binding
            channelType: duplicateSource.channelType,
          }}
          onConfirm={handleDuplicateConfirm}
        />
      )}
    </>
  );
}
