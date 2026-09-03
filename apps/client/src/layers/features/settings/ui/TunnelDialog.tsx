import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { cn, getPlatform } from '@/layers/shared/lib';
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

  if (getPlatform().isEmbedded) return null;

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
            Remote Access
          </ResponsiveDialogTitle>
          {/* Not for 'landing': `TunnelOnboarding` (inside `TunnelPanel` →
              `TunnelLanding`) already says "Access DorkOS from any device"
              under its illustration, and this header used to repeat it a few
              pixels above — the same duplicate `TunnelLanding.tsx` already
              removed from its own body, just missed here (review nit). */}
          {machine.viewState === 'connecting' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Connecting...
            </ResponsiveDialogDescription>
          )}
        </ResponsiveDialogHeader>

        <TunnelPanel machine={machine} actions={actions} className="overflow-y-auto px-4 pb-4" />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * The dot that says what remote access is doing right now.
 *
 * The app's own dot vocabulary (`shared/ui/status-dot.ts`), not the raw palette.
 * `-dot` on the amber is load-bearing: it is the variant taken to 3:1 against a
 * light surface, which a coloured dot needs and the fill-tuned `--status-warning`
 * does not meet.
 *
 * @param state - The machine's current state.
 * @param pulsing - Whether the dot should breathe (waiting on something).
 */
function TunnelStatusDot({ state, pulsing }: { state: TunnelMachine['state']; pulsing: boolean }) {
  const dotColor = {
    off: 'bg-muted-foreground/40',
    starting: 'bg-status-warning-dot',
    connected: 'bg-status-success',
    // Amber, like `starting`, and for the same reason: the tunnel is on its way
    // to being reachable, not off and not broken.
    reconnecting: 'bg-status-warning-dot',
    stopping: 'bg-muted-foreground/40',
    error: 'bg-status-error',
  }[state];

  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        dotColor,
        pulsing && 'animate-breath'
      )}
      aria-hidden
    />
  );
}
