import { useState, useEffect } from 'react';
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
import { InlineCode, Input } from '@/layers/shared/ui';
import { useDeleteAgentData } from '@/layers/entities/mesh';
import { toast } from 'sonner';

interface DeleteAgentDialogProps {
  /** Agent ID for the delete mutation. */
  agentId: string;
  /** Display name of the agent being deleted. */
  agentName: string;
  /** Absolute project path for the agent (shown in the dialog). */
  projectPath: string;
  /** Controlled open state. */
  open: boolean;
  /** Callback when the dialog opens or closes. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Type-to-confirm dialog for irreversible agent data deletion.
 *
 * Deletes the agent's `.dork` directory (agent.json, SOUL.md, NOPE.md, etc.)
 * and unregisters the agent from the mesh registry.
 */
export function DeleteAgentDialog({
  agentId,
  agentName,
  projectPath,
  open,
  onOpenChange,
}: DeleteAgentDialogProps) {
  const [confirmValue, setConfirmValue] = useState('');
  const { mutate: deleteAgent } = useDeleteAgentData();

  // Reset confirmation input when dialog opens or closes
  useEffect(() => {
    setConfirmValue('');
  }, [open]);

  const isConfirmed = confirmValue === agentName;

  function handleDelete() {
    deleteAgent(agentId, {
      onSuccess: () => {
        onOpenChange(false);
        toast.error(`Deleted ${agentName} and all data`);
      },
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {agentName} &amp; Data</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p>
                This will permanently delete the <InlineCode>.dork</InlineCode> directory at{' '}
                <InlineCode>{projectPath}/.dork/</InlineCode>, including:
              </p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                <li>
                  <InlineCode>agent.json</InlineCode> - agent manifest
                </li>
                <li>
                  <InlineCode>SOUL.md</InlineCode> - personality convention
                </li>
                <li>
                  <InlineCode>NOPE.md</InlineCode> - restriction convention
                </li>
                <li>Any other convention files</li>
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 px-1">
          <label htmlFor="delete-confirm-input" className="text-sm font-medium">
            Type <strong>{agentName}</strong> to confirm
          </label>
          <Input
            id="delete-confirm-input"
            data-testid="delete-confirm-input"
            value={confirmValue}
            onChange={(e) => setConfirmValue(e.target.value)}
            placeholder={agentName}
            autoComplete="off"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={!isConfirmed}
            onClick={handleDelete}
          >
            Delete Agent &amp; Data
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
