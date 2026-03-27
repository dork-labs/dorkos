import { useMemo } from 'react';
import { DirectoryPicker } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { useDirectoryState } from '@/layers/entities/session';
import { useResolvedAgents } from '@/layers/entities/agent';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Thin wrapper that adapts DirectoryPicker to the `DialogContribution` signature. */
export function DirectoryPickerWrapper({ open, onOpenChange }: DialogWrapperProps) {
  const [selectedCwd, setSelectedCwd] = useDirectoryState();
  const recentCwds = useAppStore((s) => s.recentCwds);
  const recentPaths = useMemo(() => recentCwds.map((r) => r.path), [recentCwds]);
  const { data: resolvedAgents } = useResolvedAgents(recentPaths);

  return (
    <DirectoryPicker
      open={open}
      onOpenChange={onOpenChange}
      onSelect={(path) => setSelectedCwd(path)}
      initialPath={selectedCwd}
      resolvedAgents={resolvedAgents}
    />
  );
}
