import { Checkbox } from '@/layers/shared/ui/checkbox';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';

interface CheckboxFieldProps {
  label: string;
  description?: string;
}

/**
 * Boolean checkbox field wired to TanStack Form field context.
 *
 * Renders a labelled checkbox with optional description and inline validation errors.
 * Errors are shown only after the field has been touched.
 */
export function CheckboxField({ label, description }: CheckboxFieldProps) {
  const field = useFieldContext<boolean>();
  const { isTouched, errors } = field.state.meta;
  const fieldErrors = isTouched ? errors.map((e) => ({ message: String(e) })) : [];

  return (
    <Field orientation="horizontal">
      <Checkbox
        id={field.name}
        checked={field.state.value}
        onBlur={field.handleBlur}
        // CheckboxPrimitive passes `boolean | 'indeterminate'`; coerce to boolean.
        onCheckedChange={(checked) => field.handleChange(checked === true)}
      />
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError errors={fieldErrors} />
    </Field>
  );
}
