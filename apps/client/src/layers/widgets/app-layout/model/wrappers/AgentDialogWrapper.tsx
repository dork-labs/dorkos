import { useDirectoryState } from '@/layers/entities/session';
import { AgentDialog, useAgentDialog } from '@/layers/features/agent-settings';
import { useAppStore } from '@/layers/shared/model';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Thin wrapper that adapts AgentDialog to the `DialogContribution` signature.
 *
 * When `useAgentDialog.projectPath` is set (e.g. from the command palette),
 * it takes precedence over the currently selected CWD.
 */
export function AgentDialogWrapper({ open, onOpenChange }: DialogWrapperProps) {
  const [selectedCwd] = useDirectoryState();
  const dialogPath = useAgentDialog((s) => s.projectPath);
  const closeDialog = useAgentDialog((s) => s.closeDialog);
  const agentDialogInitialTab = useAppStore((s) => s.agentDialogInitialTab);

  const projectPath = dialogPath ?? selectedCwd;

  if (!projectPath) return null;

  return (
    <AgentDialog
      projectPath={projectPath}
      open={open}
      onOpenChange={(o) => {
        if (!o) closeDialog();
        onOpenChange(o);
      }}
      initialTab={agentDialogInitialTab ?? undefined}
    />
  );
}
