import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { remoteAccessDotTone } from '@/layers/entities/tunnel';
import { useTunnelMachine, type TunnelMachine } from '../model/use-tunnel-machine';
import { useTunnelActions } from '../model/use-tunnel-actions';
import { TunnelPanel } from './TunnelPanel';

interface TunnelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Remote Access as a standalone dialog — the shell only; {@link TunnelPanel}
 * draws the states.
 *
 * Settings reaches remote access through its own tab now (DOR-1758), so this
 * dialog's callers are the Control Center row's "Fix…" link and one-time-setup
 * tap, and the top-bar beacon's "Manage…" (DOR-1743) — registered directly in
 * `DIALOG_CONTRIBUTIONS`, not nested inside `SettingsDialog`, since Settings is
 * no longer its only door.
 *
 * `useTunnelMachine`/`useTunnelActions` read the shared `entities/tunnel` store
 * (DOR-1743), so this dialog, the Settings tab, the Control Center row and the
 * beacon all see the same state and the same `userInitiated` suppression flag —
 * not independent copies that could disagree about whether a transition was
 * newsworthy.
 */
export function TunnelDialog({ open, onOpenChange }: TunnelDialogProps) {
  const isDesktop = !useIsMobile();

  const machine = useTunnelMachine({ open });
  const actions = useTunnelActions({ machine });

  // Pulses while the dialog is waiting on something, which now includes ngrok
  // re-establishing a dropped session — but `isTransitioning` deliberately does
  // NOT, because it also disables the switch.
  const dotPulses = machine.isTransitioning || machine.state === 'reconnecting';

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-md')}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-medium">
            <TunnelStatusDot state={machine.state} pulsing={dotPulses} />
            Remote access
          </ResponsiveDialogTitle>
          {/* Not for 'landing': `TunnelOnboarding` (inside `TunnelPanel` →
              `TunnelLanding`) already says "Access DorkOS from any device"
              under its illustration, and this header used to repeat it a few
              pixels above — the same duplicate `TunnelLanding.tsx` already
              removed from its own body, just missed here (review nit). */}
          {machine.viewState === 'connecting' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Connecting…
            </ResponsiveDialogDescription>
          )}
        </ResponsiveDialogHeader>

        <TunnelPanel machine={machine} actions={actions} className="overflow-y-auto px-4 pb-4" />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * The dot that says what remote access is doing right now, in the colour every
 * other remote-access surface uses for the same state (`remoteAccessDotTone`).
 *
 * @param state - The machine's current state.
 * @param pulsing - Whether the dot should breathe (waiting on something).
 */
function TunnelStatusDot({ state, pulsing }: { state: TunnelMachine['state']; pulsing: boolean }) {
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        remoteAccessDotTone(state),
        pulsing && 'animate-breath'
      )}
      aria-hidden
    />
  );
}
