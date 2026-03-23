import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/layers/shared/ui/alert-dialog';
import { useUnregisterAgent } from '@/layers/entities/mesh';

interface UnregisterAgentDialogProps {
  /** Display name of the agent being unregistered. */
  agentName: string;
  /** Agent ID for the unregister mutation. */
  agentId: string;
  /** Controlled open state. */
  open: boolean;
  /** Callback when the dialog opens or closes. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirmation dialog for unregistering a mesh agent.
 *
 * Informs the user that the agent can be re-discovered after unregistration
 * to reduce anxiety about irreversibility.
 */
export function UnregisterAgentDialog({
  agentName,
  agentId,
  open,
  onOpenChange,
}: UnregisterAgentDialogProps) {
  const { mutate: unregister } = useUnregisterAgent();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unregister {agentName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the agent from the mesh registry. The agent can be re-discovered by
            scanning its project directory.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => unregister(agentId)}
          >
            Unregister
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
