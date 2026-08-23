import { useAppStore } from '@/layers/shared/model';

import { FullPowerDoor } from './FullPowerDoor';

/** Props for {@link FullPowerDoorMoment}. */
export interface FullPowerDoorMomentProps {
  /** The moments rail's close handler, forwarded to the door. */
  onClose: () => void;
}

/**
 * The full-power door as the moments rail mounts it, for existing users.
 *
 * It wires the door's one host-specific seam — where "Customize…" goes: the
 * Control Center, the surface that shows and changes the whole power picture.
 * The door itself is destination-agnostic (it takes `onCustomize` as a prop).
 */
export function FullPowerDoorMoment({ onClose }: FullPowerDoorMomentProps) {
  const setControlCenterOpen = useAppStore((s) => s.setControlCenterOpen);
  return (
    <FullPowerDoor
      heading="DorkOS runs at full power"
      onClose={onClose}
      onCustomize={() => setControlCenterOpen(true)}
    />
  );
}
