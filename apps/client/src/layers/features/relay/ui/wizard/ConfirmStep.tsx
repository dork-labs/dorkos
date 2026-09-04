import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

interface ConfirmStepProps {
  manifest: AdapterManifest;
  adapterId: string;
  isEditMode: boolean;
  values: Record<string, unknown>;
  /** The bot handle the reachability check reported, when it reported one. */
  botUsername?: string;
  /** The agent that will answer, named — empty when editing. */
  agentName?: string;
}

/** Masks a secret value, revealing the last 4 characters to aid verification. */
function maskSecret(value: string): string {
  if (value.length > 8) return '\u2022\u2022\u2022\u2022 ' + value.slice(-4);
  return '\u2022\u2022\u2022';
}

/**
 * Review step: the settings about to be saved, and — when adding — who will
 * answer. The agent line leads, because that is the promise being made; the
 * settings below it are how it is kept.
 */
export function ConfirmStep({
  manifest,
  adapterId,
  isEditMode,
  values,
  botUsername,
  agentName,
}: ConfirmStepProps) {
  return (
    <div className="space-y-3">
      {!isEditMode && agentName && (
        <p className="bg-accent/30 rounded-md border px-3 py-2 text-sm">
          Messages that arrive here go to <span className="font-medium">{agentName}</span>.
        </p>
      )}
      {!isEditMode && (
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Connection ID</span>
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
      {botUsername && manifest.type === 'telegram' && (
        <a
          href={`https://t.me/${botUsername}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
        >
          Message @{botUsername} in Telegram
        </a>
      )}
    </div>
  );
}
