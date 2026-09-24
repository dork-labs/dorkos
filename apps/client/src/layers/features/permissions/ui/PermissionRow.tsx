import type { ReactNode } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import type { PermissionState } from '@dorkos/shared/permissions';
import { Button, PermissionStateSwitch } from '@/layers/shared/ui';

/** Props for {@link PermissionRow}. */
export interface PermissionRowProps {
  /** The area's id, for test ids and labels. */
  areaId: string;
  /** The row label, e.g. "Rooms". */
  label: string;
  /** One plain sentence saying what the area covers. */
  description: string;
  /** A floor area is never Allowed; its switch offers two states and a lock. */
  floor: boolean;
  /** The state the switch shows. */
  value: PermissionState | undefined;
  /** Where the state came from, in words. */
  sourceText: string;
  /** Set on an agent's row when the agent has its own setting here. */
  changed?: boolean;
  /** Called with the state a person picked. */
  onChange: (next: PermissionState) => void;
  /** Put an agent's own setting back to the default. Shown only when `changed`. */
  onReset?: () => void;
  /** Disable the controls while a write is in flight. */
  disabled?: boolean;
  /** Extra content under the switch, e.g. the "agents differ" chip. */
  footer?: ReactNode;
}

/**
 * One permission area as a row: label, one-line description, the three-way
 * switch, and where its state came from. The same row renders the default
 * layer and one agent's layer; only its caller knows where a change is written.
 *
 * @param props - See {@link PermissionRowProps}.
 */
export function PermissionRow({
  areaId,
  label,
  description,
  floor,
  value,
  sourceText,
  changed = false,
  onChange,
  onReset,
  disabled = false,
  footer,
}: PermissionRowProps) {
  return (
    <div
      className="flex flex-col gap-3 py-3 md:flex-row md:items-start md:justify-between md:gap-6"
      data-testid={`permission-row-${areaId}`}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-1.5">
          {changed ? (
            <span
              className="bg-primary size-1.5 shrink-0 rounded-full"
              aria-label="Set differently for this agent"
              role="img"
            />
          ) : null}
          <span className="text-sm font-medium">{label}</span>
          {floor ? (
            <Lock className="text-muted-foreground size-3.5" aria-label="Never Allowed" />
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">{description}</p>
        <p className="text-muted-foreground text-xs">{sourceText}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-2 md:items-end">
        <PermissionStateSwitch
          value={value}
          onChange={onChange}
          floor={floor}
          disabled={disabled}
          aria-label={label}
        />
        {changed && onReset ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start md:self-end"
            onClick={onReset}
            disabled={disabled}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset to default
          </Button>
        ) : null}
        {footer}
      </div>
    </div>
  );
}
