import { useState } from 'react';
import { Input } from '@/layers/shared/ui/input';
import { Switch } from '@/layers/shared/ui/switch';
import { Textarea } from '@/layers/shared/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui/select';
import { Label } from '@/layers/shared/ui/label';
import { Button } from '@/layers/shared/ui/button';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { ConfigField } from '@dorkos/shared/relay-schemas';

interface ConfigFieldInputProps {
  /** The field descriptor driving the rendered control. */
  field: ConfigField;
  /** Current value for this field — typed loosely because fields can hold any primitive. */
  value: unknown;
  /** Called when the field value changes; receives the field key and new value. */
  onChange: (key: string, value: unknown) => void;
  /** Validation error message to display below the input. */
  error?: string;
  /** All current form values — used for `showWhen` conditional visibility evaluation. */
  allValues: Record<string, unknown>;
}

/** Renders the appropriate shadcn/ui input control for a `ConfigField` descriptor. */
export function ConfigFieldInput({
  field,
  value,
  onChange,
  error,
  allValues,
}: ConfigFieldInputProps) {
  const [showPassword, setShowPassword] = useState(false);

  // Conditional visibility: hide this field when its dependency doesn't match.
  if (field.showWhen) {
    const dependentValue = allValues[field.showWhen.field];
    if (dependentValue !== field.showWhen.equals) {
      return null;
    }
  }

  const fieldId = `config-field-${field.key}`;
  const stringValue = value !== undefined && value !== null ? String(value) : '';

  const renderControl = () => {
    switch (field.type) {
      case 'text':
      case 'url':
        return (
          <Input
            id={fieldId}
            type={field.type === 'url' ? 'url' : 'text'}
            value={stringValue}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
          />
        );

      case 'password':
        return (
          <div className="relative">
            <Input
              id={fieldId}
              type={showPassword ? 'text' : 'password'}
              value={stringValue}
              onChange={(e) => onChange(field.key, e.target.value)}
              placeholder={field.placeholder}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-0 top-0 h-full px-3"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </Button>
          </div>
        );

      case 'number':
        return (
          <Input
            id={fieldId}
            type="number"
            value={stringValue}
            onChange={(e) =>
              onChange(field.key, e.target.value ? Number(e.target.value) : undefined)
            }
            placeholder={field.placeholder}
          />
        );

      case 'boolean':
        return (
          <Switch
            id={fieldId}
            checked={Boolean(value)}
            onCheckedChange={(checked) => onChange(field.key, checked)}
          />
        );

      case 'select':
        return (
          <Select value={stringValue} onValueChange={(v) => onChange(field.key, v)}>
            <SelectTrigger id={fieldId}>
              <SelectValue placeholder={field.placeholder ?? 'Select...'} />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'textarea':
        return (
          <Textarea
            id={fieldId}
            value={stringValue}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
            rows={3}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-2">
      <Label
        htmlFor={fieldId}
        className={cn(
          field.required && 'after:ml-0.5 after:text-red-500 after:content-["*"]',
        )}
      >
        {field.label}
      </Label>
      {renderControl()}
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

interface ConfigFieldGroupProps {
  /** All field descriptors to render, potentially spanning multiple sections. */
  fields: ConfigField[];
  /** Current form values keyed by field key. */
  values: Record<string, unknown>;
  /** Called when any field value changes. */
  onChange: (key: string, value: unknown) => void;
  /** Validation errors keyed by field key. */
  errors: Record<string, string>;
}

/**
 * Renders a list of `ConfigField` descriptors grouped by their `section` property.
 * Fields without a section are rendered first under no heading.
 */
export function ConfigFieldGroup({
  fields,
  values,
  onChange,
  errors,
}: ConfigFieldGroupProps) {
  // Preserve insertion-order grouping by section name.
  const sections = new Map<string | undefined, ConfigField[]>();
  for (const field of fields) {
    const section = field.section;
    if (!sections.has(section)) {
      sections.set(section, []);
    }
    sections.get(section)!.push(field);
  }

  return (
    <div className="space-y-6">
      {Array.from(sections.entries()).map(([section, sectionFields]) => (
        <div key={section ?? '__default'} className="space-y-4">
          {section && (
            <h4 className="text-sm font-medium text-muted-foreground">{section}</h4>
          )}
          {sectionFields.map((field) => (
            <ConfigFieldInput
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={onChange}
              error={errors[field.key]}
              allValues={values}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
