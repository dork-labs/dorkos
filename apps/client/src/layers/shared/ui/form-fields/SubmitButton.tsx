import { Button } from '@/layers/shared/ui/button';
import { useFormContext } from '@/layers/shared/lib/form-context';

export interface SubmitButtonProps {
  /** The exact action, like "Save" or "Create task". Required: a generic "Submit" names nothing. */
  label: string;
  /** What the button says while the form is sending. @default 'Saving…' */
  pendingLabel?: string;
}

/**
 * Submit button for use inside a TanStack Form `AppForm` wrapper.
 *
 * Automatically disables when the form cannot be submitted and shows a loading
 * state while submission is in progress.
 */
export function SubmitButton({ label, pendingLabel = 'Saving…' }: SubmitButtonProps) {
  const form = useFormContext();
  return (
    <form.Subscribe
      selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
    >
      {({ canSubmit, isSubmitting }) => (
        <Button type="submit" disabled={!canSubmit || isSubmitting}>
          {isSubmitting ? pendingLabel : label}
        </Button>
      )}
    </form.Subscribe>
  );
}
