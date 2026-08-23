import { Zap } from 'lucide-react';
import { useUnattendedAutonomy } from '@/layers/entities/unattended-autonomy';
import { ControlCenterDial } from './ControlCenterDial';
import { ControlCenterSwitches } from './ControlCenterSwitches';
import { OverridesLedger } from './OverridesLedger';

/** How many unattended drivers are named before the rest become a count. */
const NAMED_LIMIT = 2;

/**
 * A matter-of-fact line when something is running unattended at full power — an
 * integration or a scheduled task with nobody watching. Post-flip this is a
 * normal, chosen state, so it reads green (full power) rather than as an alarm,
 * and it appears only while a driver is live (the same aggregate the app-wide
 * banner reads, so an app-wide surface need not fetch the binding and task
 * lists).
 */
function UnattendedLine() {
  const state = useUnattendedAutonomy();
  if (!state || state.drivers.length === 0) return null;

  const named = state.drivers.slice(0, NAMED_LIMIT).map((driver) => driver.name);
  const remaining = state.drivers.length - named.length;
  const parts = remaining > 0 ? [...named, `${remaining} more`] : named;

  return (
    <p
      data-testid="control-center-unattended"
      className="text-status-success flex items-start gap-1.5 px-1 text-xs"
    >
      <Zap className="mt-px size-3 shrink-0" aria-hidden />
      <span>Running unattended at full power: {parts.join(', ')}.</span>
    </p>
  );
}

/**
 * The Control Center's contents, in the order the design fixes (spec
 * `full-power-defaults`, D7): the global dial, the power switches, the overrides
 * ledger, then the unattended-status line.
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
      <UnattendedLine />
    </div>
  );
}
