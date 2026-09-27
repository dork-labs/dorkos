import { useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { AdapterBinding, CatalogInstance } from '@dorkos/shared/relay-schemas';
import {
  BindingDialog,
  MoveChatDialog,
  readChatConflict,
  toCreateBindingRequest,
  toUpdateBindingRequest,
  useBindings,
  useCreateBinding,
  useDeleteBinding,
  useUpdateBinding,
  type BindingFormValues,
  type ChatConflict,
} from '@/layers/entities/binding';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { AdapterBindingRow } from './adapter/AdapterBindingRow';
import { BindingBridgeSection } from './BindingBridgeSection';
import { QuickBindingPopover } from './QuickBindingPopover';

/** Which binding dialog is open: a new one, or an existing binding to edit. */
type BindingTarget = { mode: 'create' } | { mode: 'edit'; binding: AdapterBinding };

interface ChatAppAnswerersProps {
  /** The chat app instance whose answerers are shown. */
  instance: CatalogInstance;
  /** The chat app's name, e.g. "Telegram". */
  appName: string;
  /**
   * Draw "Pick who answers" as the panel's main action. Off when something
   * else in the panel is the one fix to make first.
   */
  emphasizePick?: boolean;
}

/**
 * "Who answers" for one chat app: the agent (or agents, per chat) that reply
 * when someone messages the bot. With nobody set, one picker offers the
 * agents; each existing answer opens the full binding dialog.
 *
 * A chat goes to exactly one agent, so pointing one at someone new is offered
 * as a move rather than refused.
 */
export function ChatAppAnswerers({
  instance,
  appName,
  emphasizePick = true,
}: ChatAppAnswerersProps) {
  const { data: bindings = [] } = useBindings();
  const { data: agentsData } = useRegisteredAgents();
  // A chat conflict is a question, not a failure: the confirm handler below
  // tells the two apart and asks, so the shared error toast stays out of it.
  const createBinding = useCreateBinding({ suppressErrorToast: true });
  const updateBinding = useUpdateBinding({ suppressErrorToast: true });
  const deleteBinding = useDeleteBinding();
  const [target, setTarget] = useState<BindingTarget | null>(null);
  const [conflict, setConflict] = useState<ChatConflict | null>(null);

  const agents = agentsData?.agents ?? [];
  const nameOf = (agentId: string) => {
    const agent = agents.find((candidate) => candidate.id === agentId);
    return agent ? getAgentDisplayName(agent) : agentId;
  };
  const answers = bindings.filter((binding) => binding.adapterId === instance.id);

  async function quickBind(agentId: string) {
    try {
      await createBinding.mutateAsync({
        adapterId: instance.id,
        agentId,
        sessionStrategy: 'per-chat',
        label: '',
      });
      toast.success(`${nameOf(agentId)} answers ${appName} now`);
    } catch (error) {
      const found = readChatConflict(error, { id: agentId, name: nameOf(agentId) });
      if (found) {
        setConflict(found);
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Couldn’t set who answers');
    }
  }

  async function confirm(values: BindingFormValues) {
    if (!target) return;
    try {
      if (target.mode === 'edit') {
        await updateBinding.mutateAsync({
          id: target.binding.id,
          updates: toUpdateBindingRequest(values),
        });
        toast.success('Saved');
      } else {
        await createBinding.mutateAsync(toCreateBindingRequest(values));
        toast.success(`${nameOf(values.agentId)} answers ${appName} now`);
      }
      setTarget(null);
    } catch (error) {
      const found = readChatConflict(error, { id: values.agentId, name: nameOf(values.agentId) });
      if (found) {
        setConflict(found);
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Couldn’t save that');
    }
  }

  async function remove(bindingId: string) {
    try {
      await deleteBinding.mutateAsync(bindingId);
      toast.success('Removed');
      setTarget(null);
    } catch {
      // Reported by the shared mutation toast (`useDeleteBinding`'s `meta.errorLabel`).
    }
  }

  const picker = (label: string, variant: 'default' | 'outline' | 'ghost') => (
    <QuickBindingPopover
      adapterId={instance.id}
      onQuickBind={quickBind}
      onAdvanced={() => setTarget({ mode: 'create' })}
      isPending={createBinding.isPending}
    >
      <Button variant={variant} size="sm">
        <Plus className="size-3.5" aria-hidden />
        {label}
      </Button>
    </QuickBindingPopover>
  );

  const editing = target?.mode === 'edit' ? target.binding : null;

  return (
    <div className="space-y-2" data-testid="chat-app-answerers">
      {answers.length === 0 ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            No agent answers yet. Messages to the bot wait until you pick one.
          </p>
          {picker('Pick who answers', emphasizePick ? 'default' : 'outline')}
        </div>
      ) : (
        <>
          <ul className="-mx-2 space-y-0.5">
            {answers.map((binding) => (
              <li key={binding.id}>
                <button
                  type="button"
                  onClick={() => setTarget({ mode: 'edit', binding })}
                  className="group/row hover:bg-muted/50 focus-ring flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors"
                >
                  <AdapterBindingRow
                    agentName={nameOf(binding.agentId)}
                    sessionStrategy={binding.sessionStrategy}
                    chatId={binding.chatId}
                    channelType={binding.channelType}
                    canInitiate={binding.canInitiate}
                    canReply={binding.canReply}
                    canReceive={binding.canReceive}
                  />
                  <ChevronRight
                    className="text-muted-foreground ml-auto size-4 shrink-0"
                    aria-hidden
                  />
                </button>
              </li>
            ))}
          </ul>
          {picker('Add an agent', 'ghost')}
        </>
      )}

      {target && (
        <BindingDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          mode={target.mode}
          initialValues={
            editing
              ? {
                  adapterId: editing.adapterId,
                  agentId: editing.agentId,
                  sessionStrategy: editing.sessionStrategy,
                  label: editing.label ?? '',
                  permissionMode: editing.permissionMode,
                  chatId: editing.chatId,
                  channelType: editing.channelType,
                  canInitiate: editing.canInitiate,
                  canReply: editing.canReply,
                  canReceive: editing.canReceive,
                }
              : { adapterId: instance.id }
          }
          adapterName={appName}
          agentName={editing ? nameOf(editing.agentId) : undefined}
          onConfirm={confirm}
          onDelete={editing ? remove : undefined}
          bindingId={editing?.id}
          isPending={createBinding.isPending || updateBinding.isPending || deleteBinding.isPending}
          bridged={editing?.bridge === 'room'}
          bridgeSlot={
            editing ? (
              <BindingBridgeSection binding={editing} onDone={() => setTarget(null)} />
            ) : undefined
          }
        />
      )}

      <MoveChatDialog
        conflict={conflict}
        onClose={() => setConflict(null)}
        onMoved={() => setTarget(null)}
      />
    </div>
  );
}
