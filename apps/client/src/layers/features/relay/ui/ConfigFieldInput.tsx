import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Input,
  Switch,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  FieldError,
  PasswordInput,
} from '@/layers/shared/ui';
import { FieldCard, FieldCardContent } from '@/layers/shared/ui/field-card';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { MarkdownContent } from '@/layers/shared/ui/markdown-content';
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
  const [patternError, setPatternError] = useState('');

  // Conditional visibility: hide this field when its dependency doesn't match.
  if (field.showWhen) {
    const dependentValue = allValues[field.showWhen.field];
    if (dependentValue !== field.showWhen.equals) {
      return null;
    }
  }

  const fieldId = `config-field-${field.key}`;
  const stringValue = value !== undefined && value !== null ? String(value) : '';

  // Sentinel: edit mode placeholder for a saved password the user hasn't changed.
  const isSentinel = stringValue === '***';

  const handleBlur = () => {
    // Sentinel is not real content — skip pattern validation.
    if (isSentinel) {
      setPatternError('');
      return;
    }
    if (field.pattern && stringValue) {
      const regex = new RegExp(field.pattern);
      if (!regex.test(stringValue)) {
        setPatternError(field.patternMessage ?? 'Invalid format');
        return;
      }
    }
    setPatternError('');
  };

  const displayError = error ?? patternError;

  // Boolean fields render horizontally: label+description left, switch right.
  if (field.type === 'boolean') {
    return (
      <div>
        <Field orientation="horizontal" className="items-center justify-between gap-4">
          <FieldContent className="min-w-0">
            <FieldLabel
              htmlFor={fieldId}
              className={cn(
                'text-sm font-medium',
                field.required && 'after:text-destructive after:ml-0.5 after:content-["*"]'
              )}
            >
              {field.label}
            </FieldLabel>
            {field.description && (
              <FieldDescription className="text-xs">{field.description}</FieldDescription>
            )}
          </FieldContent>
          <Switch
            id={fieldId}
            checked={Boolean(value)}
            onCheckedChange={(checked) => onChange(field.key, checked)}
          />
        </Field>
        {field.helpMarkdown && (
          <Collapsible>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1 text-xs transition-colors">
              <HelpCircle className="size-3" />
              Where do I find this?
              <ChevronDown className="size-3 transition-transform [[data-state=open]_&]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="bg-muted/50 mt-2 rounded-md border p-3">
                <MarkdownContent content={field.helpMarkdown} className="text-xs" />
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        <AnimatePresence>
          {displayError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden"
            >
              <FieldError className="mt-1.5">{displayError}</FieldError>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

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
            aria-invalid={!!displayError || undefined}
          />
        );

      case 'password': {
        if (isSentinel) {
          // Sentinel mode: locked placeholder until the user focuses to replace.
          // showPassword={false} keeps the value hidden; onFocus clears to start fresh.
          return (
            <PasswordInput
              id={fieldId}
              value={stringValue}
              showPassword={false}
              onChange={(e) => {
                onChange(field.key, e.target.value.trim());
                if (patternError) setPatternError('');
              }}
              onFocus={() => onChange(field.key, '')}
              onBlur={handleBlur}
              placeholder="Saved — enter a new one to replace"
            />
          );
        }
        return (
          <PasswordInput
            id={fieldId}
            value={stringValue}
            visibleByDefault={field.visibleByDefault ?? false}
            onChange={(e) => {
              // Trim leading/trailing whitespace — tokens are always pasted and often include newlines.
              onChange(field.key, e.target.value.trim());
              if (patternError) setPatternError('');
            }}
            onBlur={handleBlur}
            onPaste={() => setTimeout(handleBlur, 0)}
            placeholder={field.placeholder}
            aria-invalid={!!displayError || undefined}
          />
        );
      }

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
            aria-invalid={!!displayError || undefined}
          />
        );

      case 'select':
        if (field.displayAs === 'radio-cards') {
          return (
            <div className="grid grid-cols-2 gap-3" role="radiogroup">
              {field.options?.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={stringValue === opt.value}
                  onClick={() => onChange(field.key, opt.value)}
                  className={cn(
                    'hover:bg-accent/50 flex flex-col items-start rounded-md border p-3 text-left transition',
                    stringValue === opt.value && 'border-primary ring-primary bg-accent/30 ring-1'
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  {opt.description && (
                    <span className="text-muted-foreground mt-1 text-xs">{opt.description}</span>
                  )}
                </button>
              ))}
            </div>
          );
        }
        return (
          <Select value={stringValue} onValueChange={(v) => onChange(field.key, v)}>
            <SelectTrigger id={fieldId} aria-invalid={!!displayError || undefined}>
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
            aria-invalid={!!displayError || undefined}
          />
        );

      default:
        return null;
    }
  };

  return (
    <Field>
      <FieldLabel
        htmlFor={fieldId}
        className={cn(
          field.required && !isSentinel && 'after:text-destructive after:ml-0.5 after:content-["*"]'
        )}
      >
        {field.label}
      </FieldLabel>
      {renderControl()}
      {field.description && (
        <FieldDescription className="text-xs">{field.description}</FieldDescription>
      )}
      {field.helpMarkdown && (
        <Collapsible>
          <CollapsibleTrigger className="text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1 text-xs transition-colors">
            <HelpCircle className="size-3" />
            Where do I find this?
            <ChevronDown className="size-3 transition-transform [[data-state=open]_&]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="bg-muted/50 mt-2 rounded-md border p-3">
              <MarkdownContent content={field.helpMarkdown} className="text-xs" />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      <AnimatePresence>
        {displayError && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <FieldError>{displayError}</FieldError>
          </motion.div>
        )}
      </AnimatePresence>
    </Field>
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

/** Check whether a field is visible given current form values. */
function isFieldVisible(field: ConfigField, allValues: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  return allValues[field.showWhen.field] === field.showWhen.equals;
}

/**
 * Renders a list of `ConfigField` descriptors grouped by their `section` property.
 * Fields without a section are rendered first under no heading.
 */
export function ConfigFieldGroup({ fields, values, onChange, errors }: ConfigFieldGroupProps) {
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
      {Array.from(sections.entries()).map(([section, sectionFields]) => {
        // Filter to visible fields to avoid empty separator gaps from showWhen nulls.
        const visibleFields = sectionFields.filter((f) => isFieldVisible(f, values));
        if (visibleFields.length === 0) return null;

        return (
          <div key={section ?? '__default'} className="space-y-3">
            {section && <h4 className="text-sm font-semibold">{section}</h4>}
            <FieldCard>
              <FieldCardContent>
                {visibleFields.map((field) => (
                  <ConfigFieldInput
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    onChange={onChange}
                    error={errors[field.key]}
                    allValues={values}
                  />
                ))}
              </FieldCardContent>
            </FieldCard>
          </div>
        );
      })}
    </div>
  );
}
