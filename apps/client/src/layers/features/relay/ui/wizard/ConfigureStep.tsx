import { Info } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { Input } from '@/layers/shared/ui/input';
import { Label } from '@/layers/shared/ui/label';
import { ConfigFieldGroup } from '../ConfigFieldInput';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

interface ConfigureStepProps {
  manifest: AdapterManifest;
  isEditMode: boolean;
  adapterId: string;
  onAdapterIdChange: (id: string) => void;
  idError: string;
  label: string;
  onLabelChange: (label: string) => void;
  fields: AdapterManifest['configFields'];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
  currentSetupStep?: { title: string; description?: string };
}

/** Form step for configuring adapter credentials and settings. */
export function ConfigureStep({
  manifest,
  isEditMode,
  adapterId,
  onAdapterIdChange,
  idError,
  label,
  onLabelChange,
  fields,
  values,
  errors,
  onChange,
  currentSetupStep,
}: ConfigureStepProps) {
  return (
    <div className="space-y-4">
      {manifest.setupInstructions && (
        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>{manifest.setupInstructions}</p>
        </div>
      )}

      {manifest.actionButton && (
        <div className="flex justify-end">
          <a href={manifest.actionButton.url} target="_blank" rel="noopener noreferrer">
            <Button type="button" variant="outline" size="sm">
              {manifest.actionButton.label}
            </Button>
          </a>
        </div>
      )}

      {currentSetupStep && (
        <h4 className="text-sm font-medium">{currentSetupStep.title}</h4>
      )}

      {!isEditMode && (
        <div className="space-y-2">
          <Label htmlFor="adapter-id" className="after:ml-0.5 after:text-red-500 after:content-['*']">
            Adapter ID
          </Label>
          <Input
            id="adapter-id"
            value={adapterId}
            onChange={(e) => onAdapterIdChange(e.target.value)}
            placeholder={manifest.type}
          />
          {idError && <p className="text-xs text-red-500">{idError}</p>}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="adapter-label">Name (optional)</Label>
        <Input
          id="adapter-label"
          placeholder={manifest.displayName}
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          A friendly name to identify this adapter instance.
        </p>
      </div>

      <ConfigFieldGroup
        fields={fields}
        values={values}
        onChange={onChange}
        errors={errors}
      />
    </div>
  );
}
