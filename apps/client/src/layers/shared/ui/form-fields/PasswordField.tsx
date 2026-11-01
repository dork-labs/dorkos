import { PasswordInput } from '@/layers/shared/ui/password-input';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';
import { useFieldWiring } from './use-field-wiring';

export interface PasswordFieldProps {
  label: string;
  placeholder?: string;
  description?: string;
}

/**
 * Password input field wired to TanStack Form field context.
 *
 * Renders a labelled password input with show/hide toggle, optional description, and inline
 * validation errors. Errors show after a blur or a submit, and replace the description while
 * they do.
 */
export function PasswordField({ label, placeholder, description }: PasswordFieldProps) {
  const field = useFieldContext<string>();
  const { fieldErrors, helpId, errorId, controlProps } = useFieldWiring(!!description);

  return (
    <Field orientation="vertical">
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <PasswordInput
        id={field.name}
        value={field.state.value}
        placeholder={placeholder}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        {...controlProps}
      />
      {description && <FieldDescription id={helpId}>{description}</FieldDescription>}
      <FieldError id={errorId} errors={fieldErrors} />
    </Field>
  );
}
