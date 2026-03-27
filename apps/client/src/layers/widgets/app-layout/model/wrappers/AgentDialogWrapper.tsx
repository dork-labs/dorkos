import { useDirectoryState } from '@/layers/entities/session';
import { AgentDialog } from '@/layers/features/agent-settings';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Thin wrapper that adapts AgentDialog to the `DialogContribution` signature. */
export function AgentDialogWrapper({ open, onOpenChange }: DialogWrapperProps) {
  const [selectedCwd] = useDirectoryState();

  if (!selectedCwd) return null;

  return <AgentDialog projectPath={selectedCwd} open={open} onOpenChange={onOpenChange} />;
}
