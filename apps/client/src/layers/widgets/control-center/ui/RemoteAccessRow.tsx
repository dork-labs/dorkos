import { SettingRow, Switch } from '@/layers/shared/ui';
import { cn, createModalHandoff } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import {
  friendlyErrorMessage,
  useRemoteAccess,
  useRemoteAccessActions,
} from '@/layers/entities/tunnel';

/** What the row says under "Remote access" when nothing has gone wrong. */
const DESCRIPTIONS = {
  unconfigured: 'Use DorkOS from your phone. One-time setup.',
  off: 'Use DorkOS from your phone or another computer.',
  starting: 'Connecting…',
  stopping: 'Turning off…',
} as const;

/**
 * Remote access, at the top of the Control Center's switches (DOR-1743).
 *
 * **Why the top row.** Every other switch in this card changes how agents
 * behave on this machine. This one changes who can reach the machine at all,
 * which is the largest thing in the panel — and it was previously three clicks
 * deep in Settings, behind a sidebar action nobody finds. It reads its state
 * from the shared model, so flipping it here is the same act as flipping it in
 * the dialog or from ⌘K.
 *
 * **The one-time-setup state does not flip.** With no ngrok token saved there
 * is nothing for a switch to turn on, so the tap opens the Remote Access dialog
 * instead — and the description says "One-time setup" so nobody presses it
 * expecting an instant tunnel. The Control Center closes on the way, because a
 * dialog under an open flyout is a dialog you have to dismiss something to
 * reach.
 *
 * **The row never carries the URL**, even when the tunnel is up: it names the
 * host so you can tell WHICH tunnel, and the beacon in the top bar owns getting
 * the address into your hands. Two places offering the same copy button is how
 * one of them goes stale.
 */
export function RemoteAccessRow() {
  const remote = useRemoteAccess();
  const actions = useRemoteAccessActions();
  const setRemoteAccessOpen = useAppStore((s) => s.setRemoteAccessOpen);
  const setControlCenterOpen = useAppStore((s) => s.setControlCenterOpen);

  // Closes this flyout before the dialog opens — the shared `pointer-events`
  // ordering, not a local one.
  const openAndClose = createModalHandoff(() => setControlCenterOpen(false));
  const openDialog = openAndClose(() => setRemoteAccessOpen(true));

  const configured = remote.tokenConfigured;
  const waiting = remote.state === 'starting' || remote.state === 'stopping';
  // Until `GET /api/config` has answered, "no token saved" is a placeholder and
  // not a fact — and the two readings send the switch to different places (a
  // tunnel, or a setup dialog). So the row waits rather than guessing, which on
  // a warm cache is imperceptible and on a cold one is the difference between
  // starting remote access and being handed a setup screen you did not ask for.
  const known = remote.hasServerReport;

  let description: React.ReactNode;
  if (!known) {
    description = DESCRIPTIONS.off;
  } else if (!configured) {
    description = DESCRIPTIONS.unconfigured;
  } else if (remote.error !== null) {
    // **Any error, not just the `error` STATE.** A refused stop leaves remote
    // access `connected` with a reason attached, and gating this branch on the
    // state meant the row snapped back to "On · host" and said nothing at all —
    // the #1458 symptom class, one surface over. What went wrong is the news
    // here; the host is ambient, and the switch still shows the true position.
    description = (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-destructive truncate">{friendlyErrorMessage(remote.error)}</span>
        <button
          type="button"
          onClick={openDialog}
          className="focus-ring text-foreground shrink-0 rounded-sm underline underline-offset-2"
        >
          Fix…
        </button>
      </span>
    );
  } else if (remote.state === 'connected') {
    description = `On · ${remote.host ?? 'connected'}`;
  } else if (remote.state === 'reconnecting') {
    // Still on: the listener is open and ngrok is re-establishing the session.
    // Saying "off" here would tell somebody their phone had lost the address
    // when it had not.
    description = remote.host ? `On · ${remote.host} · reconnecting…` : 'Reconnecting…';
  } else if (remote.state === 'starting') {
    description = DESCRIPTIONS.starting;
  } else if (remote.state === 'stopping') {
    description = DESCRIPTIONS.stopping;
  } else {
    description = DESCRIPTIONS.off;
  }

  return (
    <SettingRow
      label="Remote access"
      description={
        // The waiting breath the rest of the cockpit wears (`animate-breath`):
        // opacity only, so the line does not move, and `motion-safe` so a
        // reader who asked for less motion gets a still row that still says
        // "Connecting…".
        <span
          data-testid="remote-access-row-description"
          className={cn('block min-w-0', waiting && 'motion-safe:animate-breath')}
        >
          {description}
        </span>
      }
    >
      <Switch
        checked={configured && remote.isChecked}
        disabled={!known || (configured && remote.isTransitioning)}
        aria-label="Remote access"
        onCheckedChange={(next) => {
          if (!configured) {
            openDialog();
            return;
          }
          void actions.toggle(next);
        }}
      />
    </SettingRow>
  );
}
