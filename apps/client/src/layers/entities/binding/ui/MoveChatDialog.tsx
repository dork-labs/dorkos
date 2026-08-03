import { toast } from 'sonner';
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { useMoveBinding } from '../model/use-move-binding';

/**
 * What a `CHAT_ALREADY_BOUND` refusal carries: the binding that already owns
 * the chat, so the client can offer to move it rather than asking the person
 * to go find it.
 */
export interface ChatConflict {
  /** The binding that already owns the chat — the one `move` re-points. */
  bindingId: string;
  /** The agent answering it today. */
  currentAgentName: string;
  /** The agent the person was trying to point it at. */
  nextAgentId: string;
  /** That agent's display name. */
  nextAgentName: string;
}

/**
 * Read a thrown request error as a chat conflict, or `null` when it is
 * anything else.
 *
 * The 409 body is hand-shaped by three server routes rather than schema'd, so
 * this checks the shape it actually sends instead of trusting the code alone.
 *
 * @param error - The error a create or claim rejected with.
 * @param next - The agent the person was moving the chat to.
 */
export function readChatConflict(
  error: unknown,
  next: { id: string; name: string }
): ChatConflict | null {
  const err = error as { code?: string; body?: unknown } | null;
  if (!err || err.code !== 'CHAT_ALREADY_BOUND') return null;
  const conflict = (err.body as { conflict?: Record<string, unknown> } | undefined)?.conflict;
  const bindingId = typeof conflict?.bindingId === 'string' ? conflict.bindingId : null;
  if (!bindingId) return null;
  const currentAgent = typeof conflict?.agentId === 'string' ? conflict.agentId : 'another agent';
  return {
    bindingId,
    currentAgentName: currentAgent,
    nextAgentId: next.id,
    nextAgentName: next.name,
  };
}

interface MoveChatDialogProps {
  /** The conflict to resolve, or `null` when the dialog is closed. */
  conflict: ChatConflict | null;
  onClose: () => void;
  /** Called after the chat has moved, so the caller can close whatever asked. */
  onMoved?: () => void;
}

/**
 * One chat reaches one agent, so pointing a chat at someone new means moving
 * it, not adding a second route. This says who has it today and asks once.
 *
 * Mounted everywhere a binding can be created, so with no conflict to resolve
 * it renders nothing and asks nothing of the app around it — the move request
 * only exists once there is something to move.
 *
 * @param props - The conflict, and what to do when it is resolved or dropped.
 */
export function MoveChatDialog({ conflict, onClose, onMoved }: MoveChatDialogProps) {
  return (
    <ResponsiveDialog open={conflict !== null} onOpenChange={(next) => !next && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        {conflict && <MoveChatDialogBody conflict={conflict} onClose={onClose} onMoved={onMoved} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** The dialog's content, mounted only while there is a conflict to resolve. */
function MoveChatDialogBody({
  conflict,
  onClose,
  onMoved,
}: {
  conflict: ChatConflict;
  onClose: () => void;
  onMoved?: () => void;
}) {
  const move = useMoveBinding();

  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>This chat already reaches someone</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          A chat goes to one agent, so moving it takes it away from the one that has it now.
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <ResponsiveDialogBody className="pb-2">
        <p className="text-sm leading-relaxed">
          This chat reaches <span className="font-medium">{conflict.currentAgentName}</span>. Move
          it to <span className="font-medium">{conflict.nextAgentName}</span>?
        </p>
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          The conversation so far stays with {conflict.currentAgentName}. New messages start fresh
          with {conflict.nextAgentName}.
        </p>
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button variant="outline" onClick={onClose} disabled={move.isPending}>
          Leave it
        </Button>
        <Button
          disabled={move.isPending}
          onClick={() =>
            move.mutate(
              { id: conflict.bindingId, agentId: conflict.nextAgentId },
              {
                onSuccess: () => {
                  toast.success(`${conflict.nextAgentName} answers this chat now.`);
                  onClose();
                  onMoved?.();
                },
              }
            )
          }
        >
          {move.isPending ? 'Moving…' : `Move it to ${conflict.nextAgentName}`}
        </Button>
      </ResponsiveDialogFooter>
    </>
  );
}
