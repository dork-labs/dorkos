import { SettingsDialog } from '@/layers/features/settings';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Thin wrapper that adapts SettingsDialog to the `DialogContribution` signature. */
export function SettingsDialogWrapper({ open, onOpenChange }: DialogWrapperProps) {
  return <SettingsDialog open={open} onOpenChange={onOpenChange} />;
}
