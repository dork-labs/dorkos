import { Textarea } from '@/layers/shared/ui/textarea';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';
import { useFieldWiring } from './use-field-wiring';

export interface TextareaFieldProps {
  label: string;
  placeholder?: string;
  description?: string;
  rows?: number;
}

/**
 * Textarea field wired to TanStack Form field context.
 *
 * Renders a labelled multi-line input with optional description and inline validation errors.
 * Errors show after a blur or a submit, and replace the description while they do.
 */
export function TextareaField({ label, placeholder, description, rows }: TextareaFieldProps) {
  const field = useFieldContext<string>();
  const { fieldErrors, helpId, errorId, controlProps } = useFieldWiring(!!description);

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
        {...controlProps}
      />
      {description && <FieldDescription id={helpId}>{description}</FieldDescription>}
      <FieldError id={errorId} errors={fieldErrors} />
    </Field>
  );
}
