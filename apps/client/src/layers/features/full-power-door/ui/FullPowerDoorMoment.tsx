import { useSettingsDeepLink } from '@/layers/shared/model';

import { FullPowerDoor } from './FullPowerDoor';

/** Props for {@link FullPowerDoorMoment}. */
export interface FullPowerDoorMomentProps {
  /** The moments rail's close handler, forwarded to the door. */
  onClose: () => void;
}

/**
 * The full-power door as the moments rail mounts it, for existing users.
 *
 * It wires the door's one host-specific seam — where "Customize…" goes.
 *
 * ## Control Center integration point
 *
 * Until the Control Center lands (task 2.2, branch `fpd-control-center`),
 * "Customize…" opens **Settings → Runtimes**, the surface that holds the whole
 * power picture today. When the Control Center merges, re-point this single
 * `open('runtimes')` call at it — that is the only line to change. The door
 * itself is destination-agnostic (it takes `onCustomize` as a prop), so nothing
 * else moves.
 */
export function FullPowerDoorMoment({ onClose }: FullPowerDoorMomentProps) {
  const settings = useSettingsDeepLink();
  return (
    <FullPowerDoor
      heading="DorkOS runs at full power"
      onClose={onClose}
      onCustomize={() => settings.open('runtimes')}
    />
  );
}
