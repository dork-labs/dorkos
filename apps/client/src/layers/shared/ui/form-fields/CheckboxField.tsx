import { Checkbox } from '@/layers/shared/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  FieldError,
} from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';
import { useFieldWiring } from './use-field-wiring';

export interface CheckboxFieldProps {
  label: string;
  description?: string;
}

/**
 * Boolean checkbox field wired to TanStack Form field context.
 *
 * Renders a labelled checkbox with optional description and inline validation errors, stacked
 * in one column beside the box. Errors show after a blur or a submit, and replace the
 * description while they do.
 */
export function CheckboxField({ label, description }: CheckboxFieldProps) {
  const field = useFieldContext<boolean>();
  const { fieldErrors, helpId, errorId, controlProps } = useFieldWiring(!!description);

  return (
    <Field orientation="horizontal" className="max-md:min-h-11">
      <Checkbox
        id={field.name}
        checked={field.state.value}
        onBlur={field.handleBlur}
        // CheckboxPrimitive passes `boolean | 'indeterminate'`; coerce to boolean.
        onCheckedChange={(checked) => field.handleChange(checked === true)}
        {...controlProps}
      />
      <FieldContent>
        <FieldLabel htmlFor={field.name} className="font-normal">
          {label}
        </FieldLabel>
        {description && <FieldDescription id={helpId}>{description}</FieldDescription>}
        <FieldError id={errorId} errors={fieldErrors} />
      </FieldContent>
    </Field>
  );
}
