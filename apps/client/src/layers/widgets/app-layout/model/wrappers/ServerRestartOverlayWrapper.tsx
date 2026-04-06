import { ServerRestartOverlay } from '@/layers/features/settings';

interface DialogWrapperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Thin wrapper that adapts ServerRestartOverlay to the `DialogContribution` signature. */
export function ServerRestartOverlayWrapper({ open, onOpenChange }: DialogWrapperProps) {
  return <ServerRestartOverlay open={open} onDismiss={() => onOpenChange(false)} />;
}
