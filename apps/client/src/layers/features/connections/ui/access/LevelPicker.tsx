import { useId } from 'react';
import { SegmentedControl, SegmentedControlItem } from '@/layers/shared/ui';
import type { CardAccessLevel } from '../../lib/access-card-selection';
import { LEVEL_LABELS } from './access-labels';
import type { RequestedWriteOffer } from './RequestedAccess';

/** Props for {@link LevelPicker}. */
export interface LevelPickerProps {
  /** "They can" on the page, "It can" for one agent. */
  label: string;
  /** The app's display name, for the reason Read and write is off. */
  serviceName: string;
  /** The levels to show, lowest first. */
  levels: CardAccessLevel[];
  /** How the account offers changing things; anything but `level` greys out Read and write. */
  writeOffer: RequestedWriteOffer;
  /** The picked level, or null while agents differ. */
  level: CardAccessLevel | null;
  /** Pick a level. Never called with one the account can't give. */
  onChange: (next: CardAccessLevel) => void;
}

/**
 * The access level switch. An app with no actions under Read and write still
 * shows that level, greyed with `aria-disabled` (never `disabled`) so keyboard
 * and screen reader users can reach it, and the reason sits under it, always
 * shown (DOR-4193).
 */
export function LevelPicker({
  label,
  serviceName,
  levels,
  writeOffer,
  level,
  onChange,
}: LevelPickerProps) {
  const baseId = useId();
  const writeOff = writeOffer !== 'level';
  const shown: CardAccessLevel[] = writeOff ? ['read', 'read-write'] : levels;
  const unavailable = (option: CardAccessLevel) => writeOff && option === 'read-write';
  return (
    <>
      <p id={`${baseId}-level`} className="text-muted-foreground text-xs font-medium">
        {label}
      </p>
      {shown.length > 1 ? (
        <SegmentedControl
          aria-labelledby={`${baseId}-level`}
          // Mixed: no segment is selected until the person picks one for everyone.
          value={level ?? ''}
          onValueChange={(next) => {
            if (!unavailable(next as CardAccessLevel)) onChange(next as CardAccessLevel);
          }}
        >
          {shown.map((option) => (
            <SegmentedControlItem
              key={option}
              value={option}
              className="min-h-9 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              {...(unavailable(option) && {
                'aria-disabled': true,
                'aria-describedby': `${baseId}-write-off`,
              })}
            >
              {LEVEL_LABELS[option]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      ) : (
        <p className="text-sm">{LEVEL_LABELS[shown[0]]}</p>
      )}
      {writeOff && (
        <p
          id={`${baseId}-write-off`}
          data-testid="level-write-off"
          className="text-muted-foreground text-xs"
        >
          Read and write isn’t offered for {serviceName} yet.
        </p>
      )}
    </>
  );
}
