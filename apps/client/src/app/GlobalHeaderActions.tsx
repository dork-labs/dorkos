import { BarFixedCluster } from '@/layers/widgets/one-bar';
import { ControlCenter } from '@/layers/widgets/control-center';
import { RemoteAccessBeacon } from '@/layers/widgets/remote-access';
import { KeepAwakeBeacon } from '@/layers/widgets/keep-awake';

/**
 * Keeps the global actions on their own phone row and restores the desktop row
 * at the medium breakpoint.
 */
export function GlobalHeaderActions() {
  return (
    <div
      data-slot="global-header-actions"
      className="flex h-11 w-full items-center justify-end gap-1 md:contents"
    >
      <ControlCenter />
      <RemoteAccessBeacon />
      <KeepAwakeBeacon />
      <BarFixedCluster />
    </div>
  );
}
