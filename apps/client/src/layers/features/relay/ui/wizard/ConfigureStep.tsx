import { BookOpen, Info } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { Input } from '@/layers/shared/ui/input';
import { Label } from '@/layers/shared/ui/label';
import { MarkdownContent } from '@/layers/shared/ui/markdown-content';
import { ConfigFieldGroup, ConfigFieldInput } from '../ConfigFieldInput';
import type { AdapterManifest, ConfigField } from '@dorkos/shared/relay-schemas';
import type { ReactNode } from 'react';

/** Field render callback shape passed from form.AppField. */
interface AdapterFormField {
  state: { value: unknown; meta: { isTouched: boolean; errors: ValidationError[] } };
  handleChange: (v: unknown) => void;
  handleBlur: () => void;
}

/** Opaque validation error — TanStack Form stores strings or ValidationError objects. */
type ValidationError = { toString(): string } | string | undefined;

/**
 * Minimal structural interface for the TanStack Form instance used by ConfigureStep.
 *
 * Types only the two methods actually called here — `Subscribe` for reactive value
 * access and `AppField` for per-field binding — avoiding the full 14-param generic
 * signature of `AppFieldExtendedReactFormApi`.
 */
interface AdapterConfigFormApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Subscribe: React.ComponentType<{
    selector: (s: { values: Record<string, unknown> }) => Record<string, unknown>;
    children: (v: Record<string, unknown>) => ReactNode;
  }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AppField: React.ComponentType<{
    name: string;
    key?: string;
    children: (field: AdapterFormField) => ReactNode;
  }>;
}

interface ConfigureStepProps {
  manifest: AdapterManifest;
  label: string;
  onLabelChange: (label: string) => void;
  fields: ConfigField[];
  /** TanStack Form instance for the adapter config fields. */
  form: AdapterConfigFormApi;
  currentSetupStep?: { title: string; description?: string };
  /** Whether the adapter has a setup guide available. */
  hasSetupGuide?: boolean;
  /** Callback to open the setup guide panel. */
  onOpenGuide?: () => void;
}

/** Form step for configuring adapter credentials and settings. */
export function ConfigureStep({
  manifest,
  label,
  onLabelChange,
  fields,
  form,
  currentSetupStep,
  hasSetupGuide,
  onOpenGuide,
}: ConfigureStepProps) {
  const { Subscribe, AppField } = form;

  return (
    <div className="space-y-4">
      {manifest.setupInstructions && (
        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          <Info className="mt-0.5 size-4 shrink-0" />
          <MarkdownContent
            content={manifest.setupInstructions}
            className="text-sm text-blue-800 dark:text-blue-200"
          />
        </div>
      )}

      {(manifest.actionButton || hasSetupGuide) && (
        <div className="flex items-center justify-end gap-2">
          {hasSetupGuide && (
            <Button type="button" variant="outline" size="sm" onClick={onOpenGuide}>
              <BookOpen className="mr-1.5 size-3.5" />
              Setup Guide
            </Button>
          )}
          {manifest.actionButton && (
            <a href={manifest.actionButton.url} target="_blank" rel="noopener noreferrer">
              <Button type="button" variant="outline" size="sm">
                {manifest.actionButton.label}
              </Button>
            </a>
          )}
        </div>
      )}

      {currentSetupStep && <h4 className="text-sm font-medium">{currentSetupStep.title}</h4>}

      <div className="space-y-2">
        <Label htmlFor="adapter-label">Name (optional)</Label>
        <Input
          id="adapter-label"
          placeholder={manifest.displayName}
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          A friendly name to identify this adapter instance.
        </p>
      </div>

      <Subscribe selector={(s) => s.values}>
        {(allValues) => (
          <ConfigFieldGroup
            fields={fields}
            allValues={allValues}
            renderField={(fieldDef) => (
              <AppField key={fieldDef.key} name={fieldDef.key}>
                {(formField) => (
                  <ConfigFieldInput
                    field={fieldDef}
                    value={formField.state.value}
                    onChange={(_, v) => formField.handleChange(v)}
                    onBlur={formField.handleBlur}
                    error={
                      formField.state.meta.isTouched
                        ? formField.state.meta.errors[0]?.toString()
                        : undefined
                    }
                    allValues={allValues}
                  />
                )}
              </AppField>
            )}
          />
        )}
      </Subscribe>
    </div>
  );
}
