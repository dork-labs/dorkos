import { useTunnelMachine } from '../model/use-tunnel-machine';
import { useTunnelActions } from '../model/use-tunnel-actions';
import { Separator } from '@/layers/shared/ui';
import { TunnelPanel } from './TunnelPanel';
import { LanAccessSection } from './lan-access/LanAccessSection';

/**
 * Remote Access as a settings tab — reach this DorkOS from your phone or any
 * other device.
 *
 * It used to be a button in the sidebar's tab list that opened a second modal on
 * top of the settings modal, with the same drill-in chevron every real tab row
 * has on a phone — a control that looks like a tab must swap the panel, which is
 * the one promise a settings sidebar makes (DOR-1758).
 *
 * `useTunnelMachine`/`useTunnelActions` read the shared `entities/tunnel` store
 * (DOR-1743), so this tab is safe to mount its own call: whatever it reads and
 * writes is the same state the dialog, the Control Center row and the beacon
 * already share, not a private copy that could fall out of sync with theirs.
 *
 * `open: true` because a tab panel is only mounted while it is showing
 * (`NavigationLayoutPanel` renders nothing for an inactive value), so mounted
 * and open are the same fact here — which is what keeps the latency probe off
 * while somebody is reading a different tab.
 */
export function RemoteAccessTab() {
  const machine = useTunnelMachine({ open: true });
  const actions = useTunnelActions({ machine });

  // Nothing above the panel: it opens with an illustration and one sentence
  // saying what remote access is, and the dialog's own status dot went with the
  // dialog. A line here would be the third phrasing of the same idea on one
  // screen.
  // Wi-Fi access sits under it: another way in, for devices on the same
  // network, that needs no tunnel (DOR-2930).
  return (
    <div className="space-y-4">
      <TunnelPanel machine={machine} actions={actions} />
      <Separator />
      <LanAccessSection />
    </div>
  );
}
