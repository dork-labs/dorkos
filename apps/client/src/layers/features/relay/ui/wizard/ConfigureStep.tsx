import { BookOpen, Info } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { Input } from '@/layers/shared/ui/input';
import { Label } from '@/layers/shared/ui/label';
import { MarkdownContent } from '@/layers/shared/ui/markdown-content';
import { ConfigFieldGroup } from '../ConfigFieldInput';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

interface ConfigureStepProps {
  manifest: AdapterManifest;
  label: string;
  onLabelChange: (label: string) => void;
  fields: AdapterManifest['configFields'];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
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
  values,
  errors,
  onChange,
  currentSetupStep,
  hasSetupGuide,
  onOpenGuide,
}: ConfigureStepProps) {
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

      <ConfigFieldGroup fields={fields} values={values} onChange={onChange} errors={errors} />
    </div>
  );
}
