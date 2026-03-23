import { Switch } from '@/layers/shared/ui/switch';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';

interface SwitchFieldProps {
  label: string;
  description?: string;
}

/**
 * Boolean toggle field wired to TanStack Form field context.
 *
 * Renders a labelled switch with optional description and inline validation errors.
 * Errors are shown only after the field has been touched.
 */
export function SwitchField({ label, description }: SwitchFieldProps) {
  const field = useFieldContext<boolean>();
  const { isTouched, errors } = field.state.meta;
  const fieldErrors = isTouched ? errors.map((e) => ({ message: String(e) })) : [];

  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Switch
        id={field.name}
        checked={field.state.value}
        onBlur={field.handleBlur}
        onCheckedChange={(checked) => field.handleChange(checked)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError errors={fieldErrors} />
    </Field>
  );
}
