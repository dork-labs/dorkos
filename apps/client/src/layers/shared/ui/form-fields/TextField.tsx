import { Input } from '@/layers/shared/ui/input';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';

interface TextFieldProps {
  label: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'url' | 'number';
  description?: string;
}

/**
 * Text input field wired to TanStack Form field context.
 *
 * Renders a labelled input with optional description and inline validation errors.
 * Errors are shown only after the field has been touched.
 */
export function TextField({ label, placeholder, type = 'text', description }: TextFieldProps) {
  const field = useFieldContext<string>();
  const { isTouched, errors } = field.state.meta;
  const fieldErrors = isTouched ? errors.map((e) => ({ message: String(e) })) : [];

  return (
    <Field orientation="vertical">
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        id={field.name}
        type={type}
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
