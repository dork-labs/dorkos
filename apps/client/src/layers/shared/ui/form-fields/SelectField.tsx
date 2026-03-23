import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui/select';
import { Field, FieldLabel, FieldDescription, FieldError } from '@/layers/shared/ui/field';
import { useFieldContext } from '@/layers/shared/lib/form-context';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps {
  label: string;
  options: SelectOption[];
  placeholder?: string;
  description?: string;
}

/**
 * Select dropdown field wired to TanStack Form field context.
 *
 * Renders a labelled select with options, optional description, and inline validation errors.
 * Errors are shown only after the field has been touched.
 */
export function SelectField({ label, options, placeholder, description }: SelectFieldProps) {
  const field = useFieldContext<string>();
  const { isTouched, errors } = field.state.meta;
  const fieldErrors = isTouched ? errors.map((e) => ({ message: String(e) })) : [];

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
        <SelectTrigger id={field.name}>
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
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError errors={fieldErrors} />
    </Field>
  );
}
