import { Button } from '@/layers/shared/ui/button';
import { useFormContext } from '@/layers/shared/lib/form-context';

interface SubmitButtonProps {
  label?: string;
  pendingLabel?: string;
}

/**
 * Submit button for use inside a TanStack Form `AppForm` wrapper.
 *
 * Automatically disables when the form cannot be submitted and shows a loading
 * state while submission is in progress.
 */
export function SubmitButton({
  label = 'Submit',
  pendingLabel = 'Submitting...',
}: SubmitButtonProps) {
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
