import { Textarea } from '@/layers/shared/ui/textarea';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';

interface TextareaFieldProps {
  label: string;
  placeholder?: string;
  description?: string;
  rows?: number;
}

/**
 * Textarea field wired to TanStack Form field context.
 *
 * Renders a labelled multi-line input with optional description and inline validation errors.
 * Errors are shown only after the field has been touched.
 */
export function TextareaField({ label, placeholder, description, rows }: TextareaFieldProps) {
  const field = useFieldContext<string>();
  const { isTouched, errors } = field.state.meta;
  const fieldErrors = isTouched ? errors.map((e) => ({ message: String(e) })) : [];

  return (
    <Field orientation="vertical">
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Textarea
        id={field.name}
        value={field.state.value}
        placeholder={placeholder}
        rows={rows}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError errors={fieldErrors} />
    </Field>
  );
}
