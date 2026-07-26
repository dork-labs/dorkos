/**
 * The "make your own version" form in the Shape switcher's footer (DOR-402).
 *
 * A plain inline form — no dropdown menu anywhere in the flow. A Radix menu
 * closing blur-cancels the input it just opened, so a menu → text-input flow
 * would walk straight into that bug.
 *
 * @module features/shapes/ui/ShapeForkForm
 */
import { useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button, Input, Label } from '@/layers/shared/ui';
import { useForkShape } from '../model/use-fork-shape';

/** Props for {@link ShapeForkForm}. */
export interface ShapeForkFormProps {
  /** The active Shape to copy. Its slug seeds the suggested name. */
  shapeName: string;
  /** Leave the form and put the footer back at rest (Cancel, or a copy landed). */
  onDone: () => void;
}

/**
 * Kebab-case Shape-name shape. Mirrors the server's own check so a bad name is
 * caught before the round trip; the server still rejects one as defense in depth.
 */
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** What to tell someone who typed a name the server would refuse. */
const SLUG_HELP = 'Use lowercase letters, numbers, and dashes, starting with a letter.';

/**
 * The inline name-your-copy form.
 *
 * @param props - The Shape being copied and the "return to rest" callback.
 */
export function ShapeForkForm({ shapeName, onDone }: ShapeForkFormProps) {
  const forkShape = useForkShape();
  // Pre-filled with the API's own default so Enter alone is a valid answer.
  const [name, setName] = useState(`${shapeName}-fork`);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  // The server's refusal (a taken name is a 409) is shown verbatim, never swallowed.
  const error = localError ?? (forkShape.error ? forkShape.error.message : null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!SLUG_RE.test(trimmed)) {
      setLocalError(SLUG_HELP);
      return;
    }
    setLocalError(null);
    forkShape.reset();
    forkShape.mutate({ name: shapeName, as: trimmed }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Label htmlFor={inputId}>Name your version</Label>
      <Input
        id={inputId}
        value={name}
        // Opening the form is an explicit click on "Make your own version", so
        // landing in the field it just revealed is what the person expects.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onChange={(e) => {
          setName(e.target.value);
          setLocalError(null);
          if (forkShape.error) forkShape.reset();
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        disabled={forkShape.isPending}
      />
      <p id={hintId} className="text-muted-foreground text-xs">
        Your copy keeps the extensions you have turned on and the way your panels are arranged right
        now.
      </p>
      {error && (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" size="sm" disabled={forkShape.isPending}>
          {forkShape.isPending && <Loader2 className="size-[--size-icon-xs] animate-spin" />}
          Create
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={forkShape.isPending}
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
