import { BarFixedCluster } from '@/layers/widgets/one-bar';
import { ControlCenter } from '@/layers/widgets/control-center';
import { RemoteAccessBeacon } from '@/layers/widgets/remote-access';
import { KeepAwakeBeacon } from '@/layers/widgets/keep-awake';

/**
 * Keeps the global actions together on a phone, beside the route's identity
 * when they fit and on a row of their own when a beacon pushes them past it.
 * From the medium breakpoint the header stops wrapping, so this sits at the end
 * of the desktop's single row at the bar's own height and spacing.
 *
 * It stays a real box at every width rather than `display: contents`: a box
 * with no size of its own leaves every action outside its parent, which is
 * what the responsive containment sweep measures against.
 */
export function GlobalHeaderActions() {
  return (
    <div
      data-slot="global-header-actions"
      className="ml-auto flex h-11 items-center justify-end gap-1 md:h-auto md:shrink-0 lg:gap-2"
    >
      <ControlCenter />
      <RemoteAccessBeacon />
      <KeepAwakeBeacon />
      <BarFixedCluster />
    </div>
  );
}
