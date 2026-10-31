import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui/select';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';
import { useFieldWiring } from './use-field-wiring';

interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label: string;
  options: SelectOption[];
  placeholder?: string;
  description?: string;
}

/**
 * Select dropdown field wired to TanStack Form field context.
 *
 * Renders a labelled select with options, optional description, and inline validation errors.
 * Errors show after a blur or a submit, and replace the description while they do.
 */
export function SelectField({ label, options, placeholder, description }: SelectFieldProps) {
  const field = useFieldContext<string>();
  const { fieldErrors, helpId, errorId, controlProps } = useFieldWiring(!!description);

  return (
    <Field orientation="vertical">
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Select
        value={field.state.value}
        onValueChange={(value) => field.handleChange(value)}
        onOpenChange={(open) => {
          if (!open) field.handleBlur();
        }}
      >
        <SelectTrigger id={field.name} {...controlProps}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && <FieldDescription id={helpId}>{description}</FieldDescription>}
      <FieldError id={errorId} errors={fieldErrors} />
    </Field>
  );
}
