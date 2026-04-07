import { useDirectoryState } from '@/layers/entities/session';
import { AgentDialog, useAgentDialog } from '@/layers/features/agent-settings';
import { useAppStore, useAgentDialogDeepLink } from '@/layers/shared/model';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Thin wrapper that adapts AgentDialog to the `DialogContribution` signature.
 *
 * Path resolution precedence (first match wins):
 *
 * 1. `useAgentDialog.projectPath` — set by in-app openers like the command palette
 * 2. `useAgentDialogDeepLink().agentPath` — URL `?agentPath=...` for shareable deep links
 * 3. `useDirectoryState` selected CWD — the fallback for the user's current agent
 *
 * Reading the URL signal directly in the wrapper is required because a fresh
 * tab with `/?agent=identity&agentPath=/foo` will mount the wrapper before
 * `selectedCwd` hydrates; without this, the short-circuit below would drop
 * the deep link entirely.
 */
export function AgentDialogWrapper({ open, onOpenChange }: DialogWrapperProps) {
  const [selectedCwd] = useDirectoryState();
  const dialogPath = useAgentDialog((s) => s.projectPath);
  const closeDialog = useAgentDialog((s) => s.closeDialog);
  const agentDialogInitialTab = useAppStore((s) => s.agentDialogInitialTab);
  const { agentPath: urlAgentPath } = useAgentDialogDeepLink();

  const projectPath = dialogPath ?? urlAgentPath ?? selectedCwd;

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
