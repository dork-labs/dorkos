import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

interface ConfirmStepProps {
  manifest: AdapterManifest;
  adapterId: string;
  isEditMode: boolean;
  values: Record<string, unknown>;
}

/** Masks a secret value, revealing the last 4 characters to aid verification. */
function maskSecret(value: string): string {
  if (value.length > 8) return '\u2022\u2022\u2022\u2022 ' + value.slice(-4);
  return '\u2022\u2022\u2022';
}

/** Review step showing a summary of the adapter configuration before saving. */
export function ConfirmStep({ manifest, adapterId, isEditMode, values }: ConfirmStepProps) {
  return (
    <div className="space-y-3">
      {!isEditMode && (
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Adapter ID</span>
          <span className="font-mono">{adapterId}</span>
        </div>
      )}
      {manifest.configFields.map((field) => {
        // Skip hidden fields in summary.
        if (field.showWhen) {
          const depValue = values[field.showWhen.field];
          if (depValue !== field.showWhen.equals) return null;
        }
        const rawValue = String(values[field.key] ?? '');
        const displayValue = field.type === 'password' ? maskSecret(rawValue) : rawValue;
        return (
          <div key={field.key} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{field.label}</span>
            <span className="max-w-[200px] truncate font-mono">{displayValue}</span>
          </div>
        );
      })}
    </div>
  );
}
