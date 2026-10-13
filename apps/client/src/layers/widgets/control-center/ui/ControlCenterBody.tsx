import { Coffee } from 'lucide-react';
import { describeKeepAwakeWork, isKeepingAwake, useKeepAwake } from '@/layers/entities/keep-awake';
import { ControlCenterDial } from './ControlCenterDial';
import { ControlCenterSwitches } from './ControlCenterSwitches';
import { OverridesLedger } from './OverridesLedger';

/**
 * A plain line while DorkOS is keeping this computer awake for work, the same
 * fact the top-bar cup states. Absent otherwise.
 */
function KeepAwakeLine() {
  const status = useKeepAwake();
  if (!isKeepingAwake(status)) return null;
  return (
    <p
      data-testid="control-center-keep-awake"
      className="text-muted-foreground flex items-start gap-1.5 px-1 text-xs"
    >
      <Coffee className="mt-px size-3 shrink-0" aria-hidden />
      <span>Keeping this computer awake: {describeKeepAwakeWork(status.working)}.</span>
    </p>
  );
}

/**
 * The Control Center's contents, in the order the design fixes (spec
 * `full-power-defaults`, D7): the global dial, the power switches, the overrides
 * ledger, then the keep-awake line.
 *
 * Split from the popover shell so it can be shown in the Dev Playground and
 * driven in tests without a trigger.
 */
export function ControlCenterBody() {
  return (
    <div className="flex flex-col gap-4" data-testid="control-center-body">
      <ControlCenterDial />
      <ControlCenterSwitches />
      <OverridesLedger />
      <KeepAwakeLine />
    </div>
  );
}
