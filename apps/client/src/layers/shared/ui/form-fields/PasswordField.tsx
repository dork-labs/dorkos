import { PasswordInput } from '@/layers/shared/ui/password-input';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';

interface PasswordFieldProps {
  label: string;
  placeholder?: string;
  description?: string;
}

/**
 * Password input field wired to TanStack Form field context.
 *
 * Renders a labelled password input with show/hide toggle, optional description, and inline
 * validation errors. Errors are shown only after the field has been touched.
 */
export function PasswordField({ label, placeholder, description }: PasswordFieldProps) {
  const field = useFieldContext<string>();
  const { isTouched, errors } = field.state.meta;
  const fieldErrors = isTouched ? errors.map((e) => ({ message: String(e) })) : [];

  return (
    <Field orientation="vertical">
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <PasswordInput
        id={field.name}
        value={field.state.value}
        placeholder={placeholder}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError errors={fieldErrors} />
    </Field>
  );
}
