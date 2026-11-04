import { useId } from 'react';
import { Lock, LockOpen, Plus, X } from 'lucide-react';
import { SECRET_NAME_PATTERN } from '@dorkos/shared/global-mcp-schemas';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  Input,
  PasswordInput,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { rowIsSecret, type FieldRow } from '../lib/server-form';

interface FieldRowsProps {
  /** What the rows are, for a screen reader and the button: "variable" or "header". */
  noun: 'variable' | 'header';
  /** The rows. */
  rows: FieldRow[];
  /** Replace the rows. */
  onChange: (rows: FieldRow[]) => void;
  /** Nothing can change while the change is in flight. */
  disabled?: boolean;
  /** Describes the first control when the form has a problem here. */
  describedBy?: string;
}

/**
 * Name and value rows for a server's environment or headers. A name matching the secret rule, or
 * one the person locked, takes its value in a hidden field that only a person ever fills.
 */
export function FieldRows({ noun, rows, onChange, disabled, describedBy }: FieldRowsProps) {
  const baseId = useId();
  const update = (id: string, patch: Partial<FieldRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const secret = rowIsSecret(row);
        const label = row.name.trim() || `this ${noun}`;
        return (
          <div
            key={row.id}
            data-testid={`field-row-${index}`}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
          >
            <Input
              value={row.name}
              onChange={(event) => update(row.id, { name: event.target.value })}
              aria-label={`Name of ${noun} ${index + 1}`}
              aria-describedby={index === 0 ? describedBy : undefined}
              placeholder="NAME"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className="font-mono"
            />
            <div className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto">
              {secret ? (
                <PasswordInput
                  id={`${baseId}-${row.id}`}
                  value={row.value}
                  onChange={(event) => update(row.id, { value: event.target.value })}
                  aria-label={`Value of ${label}`}
                  // A browser ignores "off" on a password field and offers to save it.
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={disabled}
                  className="font-mono"
                />
              ) : (
                <Input
                  id={`${baseId}-${row.id}`}
                  value={row.value}
                  onChange={(event) => update(row.id, { value: event.target.value })}
                  aria-label={`Value of ${label}`}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                  className="font-mono"
                />
              )}
            </div>
            <OnlyYouToggle
              pressed={secret}
              locked={SECRET_NAME_PATTERN.test(row.name.trim())}
              disabled={disabled}
              onToggle={() => update(row.id, { marked: !row.marked })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="max-sm:size-11"
              disabled={disabled}
              aria-label={`Remove ${label}`}
              onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}
            >
              <X className="size-(--size-icon-sm)" aria-hidden />
            </Button>
          </div>
        );
      })}
      {rows.some(rowIsSecret) && (
        <p className="text-muted-foreground text-xs">It stays hidden after this.</p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="max-sm:h-11"
        disabled={disabled}
        onClick={() =>
          onChange([...rows, { id: crypto.randomUUID(), name: '', value: '', marked: false }])
        }
      >
        <Plus className="size-(--size-icon-sm)" aria-hidden />
        {noun === 'variable' ? 'Add a variable' : 'Add a header'}
      </Button>
    </div>
  );
}

/**
 * The lock on a row, named "Only you" on hover and focus. A name matching the secret rule is on
 * and stays on: unlocking it would put the value in a file and back in the list. It keeps its
 * focus when locked, so the name can still be read.
 */
function OnlyYouToggle({
  pressed,
  locked,
  disabled,
  onToggle,
}: {
  pressed: boolean;
  locked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const Icon = pressed ? Lock : LockOpen;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label="Only you"
          aria-pressed={pressed}
          aria-disabled={locked || undefined}
          disabled={disabled}
          className={cn('max-sm:size-11', locked && 'cursor-not-allowed')}
          onClick={() => {
            if (!locked) onToggle();
          }}
        >
          <Icon
            className={cn('size-(--size-icon-sm)', !pressed && 'text-muted-foreground')}
            aria-hidden
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Only you</TooltipContent>
    </Tooltip>
  );
}
