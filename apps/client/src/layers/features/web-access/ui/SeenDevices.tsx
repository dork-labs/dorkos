import type { SessionRelayDevice } from '@dorkos/shared/session-relay-link';
import { formatRelativeTime } from '@/layers/shared/lib';

/**
 * Browsers by the hub's label, each with when it was last seen. Draws nothing
 * for an empty list; the caller says what an empty list means.
 */
export function DeviceList({ devices }: { devices: SessionRelayDevice[] }) {
  if (devices.length === 0) return null;
  return (
    <ul className="space-y-1">
      {devices.map((device) => (
        <li
          key={`${device.label}-${device.firstSeenAt}`}
          className="flex items-baseline justify-between gap-3 text-sm"
        >
          <span className="truncate">{device.label}</span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {formatRelativeTime(device.lastSeenAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The browsers that have used chat from the web on this computer, in the
 * Settings section (step B3, DOR-2946). Nothing until one has.
 */
export function SeenDevices({ devices }: { devices: SessionRelayDevice[] }) {
  if (devices.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="web-access-devices">
      <p className="text-muted-foreground text-xs font-medium">Devices that used this</p>
      <DeviceList devices={devices} />
    </div>
  );
}
