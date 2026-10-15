import type { RemoteAccessMode } from '@dorkos/shared/config-schema';
import { FieldError, SegmentedControl, SegmentedControlItem } from '@/layers/shared/ui';

/** Props for {@link RemoteAccessModeChoice}. */
export interface RemoteAccessModeChoiceProps {
  /** The choice drawn as selected. */
  value: RemoteAccessMode;
  /** Called with the person's pick. */
  onChange: (mode: RemoteAccessMode) => void;
  /** While a change or a start is in flight. */
  disabled: boolean;
  /** Why the last change was refused, or `null`. */
  error: string | null;
}

/** The three ways, in order from closed to most hands-off. */
const OPTIONS: { value: RemoteAccessMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'byo', label: 'Your ngrok' },
  { value: 'managed', label: 'DorkOS' },
];

/** Narrow a radio value back to a mode; Radix hands back a bare string. */
function isMode(value: string): value is RemoteAccessMode {
  return OPTIONS.some((option) => option.value === value);
}

/**
 * How other devices reach this computer: not at all, through the person's own
 * ngrok account, or through an address from DorkOS (DOR-2086).
 *
 * Shown only while DorkOS offers managed access here; otherwise the panel is
 * the ngrok setup alone, as it always was.
 */
export function RemoteAccessModeChoice({
  value,
  onChange,
  disabled,
  error,
}: RemoteAccessModeChoiceProps) {
  return (
    <div className="space-y-1.5">
      <SegmentedControl
        value={value}
        onValueChange={(next) => {
          if (isMode(next)) onChange(next);
        }}
        disabled={disabled}
        aria-label="How other devices reach this computer"
      >
        {OPTIONS.map((option) => (
          <SegmentedControlItem key={option.value} value={option.value}>
            {option.label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
