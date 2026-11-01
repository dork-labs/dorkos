import { useState } from 'react';
import { Coffee } from 'lucide-react';
import { describeKeepAwakeWork, isKeepingAwake, useKeepAwake } from '@/layers/entities/keep-awake';
import { SegmentedControl, SegmentedControlItem } from '@/layers/shared/ui';
import { ControlCenterDial } from './ControlCenterDial';
import { ControlCenterSwitches } from './ControlCenterSwitches';
import { OverridesLedger } from './OverridesLedger';
import { TeamBoard } from './TeamBoard';

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
 * ledger, then the keep-awake line. A second view, Team, shows who is running
 * (DOR-3461). It opens on Power, and only the view showing is mounted, so Team
 * polls nothing while it is hidden.
 *
 * Split from the popover shell so it can be shown in the Dev Playground and
 * driven in tests without a trigger.
 */
export function ControlCenterBody() {
  const [view, setView] = useState<'power' | 'team'>('power');
  return (
    <div className="flex flex-col gap-4" data-testid="control-center-body">
      <SegmentedControl
        aria-label="Control Center view"
        value={view}
        onValueChange={(next) => setView(next as 'power' | 'team')}
      >
        <SegmentedControlItem value="power">Power</SegmentedControlItem>
        <SegmentedControlItem value="team">Team</SegmentedControlItem>
      </SegmentedControl>
      {view === 'team' ? (
        <TeamBoard />
      ) : (
        <>
          <ControlCenterDial />
          <ControlCenterSwitches />
          <OverridesLedger />
          <KeepAwakeLine />
        </>
      )}
    </div>
  );
}
