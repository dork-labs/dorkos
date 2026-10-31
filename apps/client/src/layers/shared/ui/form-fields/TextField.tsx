import { Input } from '@/layers/shared/ui/input';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';
import { useFieldWiring } from './use-field-wiring';

export interface TextFieldProps {
  label: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'url' | 'number';
  description?: string;
}

/**
 * Text input field wired to TanStack Form field context.
 *
 * Renders a labelled input with optional description and inline validation errors.
 * Errors show after a blur or a submit, and replace the description while they do.
 */
export function TextField({ label, placeholder, type = 'text', description }: TextFieldProps) {
  const field = useFieldContext<string>();
  const { fieldErrors, helpId, errorId, controlProps } = useFieldWiring(!!description);

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
        {...controlProps}
      />
      {description && <FieldDescription id={helpId}>{description}</FieldDescription>}
      <FieldError id={errorId} errors={fieldErrors} />
    </Field>
  );
}
