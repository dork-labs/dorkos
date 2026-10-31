import { Switch } from '@/layers/shared/ui/switch';
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  FieldError,
} from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';
import { useFieldWiring } from './use-field-wiring';

export interface SwitchFieldProps {
  label: string;
  description?: string;
}

/**
 * Boolean toggle field wired to TanStack Form field context.
 *
 * Renders a labelled switch with optional description and inline validation errors, stacked
 * in one column beside the track. Errors show after a blur or a submit, and replace the
 * description while they do.
 */
export function SwitchField({ label, description }: SwitchFieldProps) {
  const field = useFieldContext<boolean>();
  const { fieldErrors, helpId, errorId, controlProps } = useFieldWiring(!!description);

  return (
    <Field orientation="horizontal" className="justify-between gap-4 max-md:min-h-11 max-md:gap-4">
      <FieldContent>
        <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
        {description && <FieldDescription id={helpId}>{description}</FieldDescription>}
        <FieldError id={errorId} errors={fieldErrors} />
      </FieldContent>
      <Switch
        id={field.name}
        checked={field.state.value}
        onBlur={field.handleBlur}
        onCheckedChange={(checked) => field.handleChange(checked)}
        {...controlProps}
      />
    </Field>
  );
}
