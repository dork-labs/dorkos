import { useTunnelMachine } from '../model/use-tunnel-machine';
import { useTunnelActions } from '../model/use-tunnel-actions';
import { useLanAccess } from '../model/use-lan-access';
import { useRemoteAccessSwitch } from '../model/use-remote-access-switch';
import { Separator } from '@/layers/shared/ui';
import { TunnelPanel } from './TunnelPanel';
import { LanAccessSection } from './lan-access/LanAccessSection';
import { RemoteAccessSwitch } from './remote-access/RemoteAccessSwitch';

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
  const remote = useRemoteAccessSwitch();
  const lan = useLanAccess();

  // Turning it on needs nothing more, unless no way in is set up yet: then the
  // existing tunnel setup opens, as "Get started" would.
  const handleChange = async (enabled: boolean) => {
    const taken = await remote.setEnabled(enabled);
    const nothingSetUp = machine.viewState === 'landing' && !lan.status?.enabled;
    if (taken && enabled && nothingSetUp) machine.setShowSetup(true);
  };

  // The switch sits on top and closes every way in at once (DOR-3650). While it
  // is off the ways in below are hidden: none of them can let a device in.
  // Wi-Fi access sits under the tunnel: another way in, for devices on the same
  // network, that needs no tunnel (DOR-2930).
  // Nothing until the config is read, so the switch never shows a guess.
  if (remote.enabled === undefined) return null;

  return (
    <div className="space-y-4">
      <RemoteAccessSwitch
        enabled={remote.enabled}
        busy={remote.busy}
        error={remote.error}
        onChange={(enabled) => void handleChange(enabled)}
      />
      {remote.enabled && (
        <>
          <Separator />
          <TunnelPanel machine={machine} actions={actions} />
          <Separator />
          <LanAccessSection />
        </>
      )}
    </div>
  );
}
