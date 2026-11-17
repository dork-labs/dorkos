import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import { getActionStepUpShowing, subscribeActionStepUp, cn } from '@/layers/shared/lib';
import { Button, Input, Label } from '@/layers/shared/ui';
import { fieldValueOf, parseSpendAmount } from '../../lib/spending-lines';

/** Props for {@link SpendAmountField}. */
export interface SpendAmountFieldProps {
  /** The field's label, e.g. "Monthly limit". */
  label: string;
  /** Shown while the field is empty, e.g. "Ask every time". */
  placeholder: string;
  /** The saved amount in micro-units, or null for none. */
  savedMicro: string | null;
  /** The server's largest accepted amount. */
  maxMicro: string;
  /** Lines under the field, read with it. */
  help: ReactNode;
  /** False while DorkOS can't be reached: nothing saves. */
  online: boolean;
  /** Save a new amount; resolves once saved, after "Confirm it's you" when the server holds it. */
  onSave: (micro: string | null) => Promise<unknown>;
  /** Classes for the input, e.g. its width. */
  inputClassName?: string;
  /** Put the cursor in the field once it shows (a notice's Raise limit). */
  autoFocus?: boolean;
}

/**
 * A `$` amount and its Save (DOR-4204 spec §2.1-§2.3, §11): Enter saves, Esc
 * puts the saved value back, and an amount below a cent or past the maximum
 * never saves. While "Confirm it's you" is open the field shows the amount it
 * waits on, dimmed; cancelling puts the saved value back at once.
 */
export function SpendAmountField({
  label,
  placeholder,
  savedMicro,
  maxMicro,
  help,
  online,
  onSave,
  inputClassName,
  autoFocus = false,
}: SpendAmountFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  // What the person typed, or null while the field shows the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const stepUp = useSyncExternalStore(subscribeActionStepUp, getActionStepUpShowing);
  const saved = fieldValueOf(savedMicro);
  const value = draft ?? saved;
  const parsed = parseSpendAmount(value, maxMicro);
  const changed = parsed.ok && parsed.micro !== savedMicro;
  const held = pending && stepUp !== null;
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  async function save() {
    if (!parsed.ok || !changed || pending || !online) return;
    setPending(true);
    setFailed(false);
    try {
      await onSave(parsed.micro);
      setDraft(null);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === STEP_UP_REQUIRED_CODE) {
        // Not confirmed: the saved value comes back at once, and so does focus.
        setDraft(null);
        input.current?.focus();
      } else {
        setFailed(true);
      }
    } finally {
      setPending(false);
    }
  }

  const describedBy = `${id}-help${!parsed.ok ? ` ${id}-error` : ''}`;
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Label htmlFor={`${id}-amount`}>{label}</Label>
      <div className="flex items-center gap-2">
        <div className={cn('relative min-w-0 flex-1 sm:flex-none', held && 'opacity-60')}>
          <span
            className="text-muted-foreground pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm"
            aria-hidden
          >
            $
          </span>
          <Input
            ref={input}
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && draft !== null) {
                event.preventDefault();
                setDraft(null);
              }
            }}
            aria-invalid={!parsed.ok}
            aria-describedby={describedBy}
            aria-busy={held || undefined}
            readOnly={pending}
            className={cn('h-11 pl-7 tabular-nums sm:h-9', inputClassName)}
          />
        </div>
        <Button
          type="submit"
          className="h-11 sm:h-9"
          disabled={!online || !parsed.ok || !changed || pending}
        >
          {pending && !held ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div id={`${id}-help`} className="text-muted-foreground space-y-0.5 text-xs">
        {help}
      </div>
      {!parsed.ok && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-xs">
          {parsed.error}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t save. Try again.
        </p>
      )}
    </form>
  );
}
