import { useFieldContext } from '@/layers/shared/lib/form-context';

/**
 * What a form-fields wrapper needs to tie its control to its words.
 *
 * Errors wait for a blur or a submit, so nobody is told off during first typing,
 * and clear as soon as the value is valid. While one shows, the control is marked
 * invalid and described by the error; otherwise it is described by its help.
 *
 * @param hasDescription - Whether the wrapper renders help text to point at.
 */
export function useFieldWiring(hasDescription: boolean) {
  const field = useFieldContext<unknown>();
  const { isBlurred, errors } = field.state.meta;
  const shown = isBlurred || field.form.state.submissionAttempts > 0;
  const fieldErrors = shown ? errors.map((e) => ({ message: String(e) })) : [];
  const invalid = fieldErrors.length > 0;
  const helpId = `${field.name}-help`;
  const errorId = `${field.name}-error`;

  return {
    fieldErrors,
    helpId,
    errorId,
    controlProps: {
      'aria-invalid': invalid || undefined,
      'aria-describedby': invalid ? errorId : hasDescription ? helpId : undefined,
    },
  };
}
