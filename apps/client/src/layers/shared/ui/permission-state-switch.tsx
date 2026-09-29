import * as React from 'react';
import type { PermissionState } from '@dorkos/shared/permissions';

import { cn } from '@/layers/shared/lib/utils';
import { SegmentedControl, SegmentedControlItem } from './segmented-control';
import { TOUCH_TARGET_MIN_H } from './touch-target';

/** The three states in the order a person reads them: strictest first. */
const STATES: readonly { value: PermissionState; label: string }[] = [
  { value: 'blocked', label: 'Blocked' },
  { value: 'ask', label: 'Ask' },
  { value: 'allowed', label: 'Allowed' },
];

/** Props for {@link PermissionStateSwitch}. */
export interface PermissionStateSwitchProps {
  /** The state shown as selected; `undefined` shows none (still loading). */
  value: PermissionState | undefined;
  /** Called with the state a person picked. */
  onChange: (next: PermissionState) => void;
  /**
   * A floor area is never Allowed, so only Blocked and Ask are offered (spec
   * `agent-permissions` D3).
   */
  floor?: boolean;
  /** Disable the whole control, e.g. while a write is in flight. */
  disabled?: boolean;
  /** What the control is about, for assistive technology. */
  'aria-label': string;
  /** Extra classes for the row. */
  className?: string;
}

/**
 * The three-way permission switch: Blocked · Ask · Allowed.
 *
 * A radiogroup built on {@link SegmentedControl}, so arrow keys move between the
 * states and there is one Tab stop for the row. Full width with 44px segments
 * on a narrow screen. No state is drawn in red: red is reserved for alarms, and
 * Blocked is a setting a person chose, not something wrong (ADR `260822-235801`).
 *
 * @param props - See {@link PermissionStateSwitchProps}.
 */
export function PermissionStateSwitch({
  value,
  onChange,
  floor = false,
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: PermissionStateSwitchProps) {
  const states = floor ? STATES.filter((s) => s.value !== 'allowed') : STATES;
  return (
    <SegmentedControl
      aria-label={ariaLabel}
      value={value ?? ''}
      onValueChange={(next) => onChange(next as PermissionState)}
      disabled={disabled}
      className={cn('w-full md:w-auto', className)}
    >
      {states.map((state) => (
        <SegmentedControlItem
          key={state.value}
          value={state.value}
          className={cn(TOUCH_TARGET_MIN_H, 'md:min-h-0 md:min-w-16')}
        >
          {state.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
