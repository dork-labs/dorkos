import { BarFixedCluster } from '@/layers/widgets/one-bar';
import { ControlCenter } from '@/layers/widgets/control-center';
import { RemoteAccessBeacon } from '@/layers/widgets/remote-access';
import { KeepAwakeBeacon } from '@/layers/widgets/keep-awake';

/**
 * Keeps the global actions together on a phone, beside the route's identity
 * when they fit and on a row of their own when a beacon pushes them past it.
 * At the medium breakpoint `contents` restores the desktop's single row.
 */
export function GlobalHeaderActions() {
  return (
    <div
      data-slot="global-header-actions"
      className="ml-auto flex h-11 items-center justify-end gap-1 md:contents"
    >
      <ControlCenter />
      <RemoteAccessBeacon />
      <KeepAwakeBeacon />
      <BarFixedCluster />
    </div>
  );
}
