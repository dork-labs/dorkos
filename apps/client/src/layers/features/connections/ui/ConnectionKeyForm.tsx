import { useId, useState } from 'react';
import { useSaveConnectorCredential } from '@/layers/entities/connectors';
import { Button, Label, PasswordInput } from '@/layers/shared/ui';
import { providerName } from '../lib/presentation';

/** Props for {@link ConnectionKeyForm}. */
export interface ConnectionKeyFormProps {
  /** The key's type, e.g. `'composio'` or `'nango'`. */
  type: string;
  /** The submit button's words. */
  submitLabel: string;
  /** Called once the server has taken the key. */
  onSaved?: () => void;
  /** Called when the person backs out without saving. Omit to show no Cancel. */
  onCancel?: () => void;
}

/**
 * Paste one of your own keys and save it. The key travels once, into the
 * server's encrypted store, and the server starts using it straight away.
 *
 * A save that fails keeps what was typed and says why through the app-wide
 * mutation toast (the save hook carries its own error label), so nothing
 * vanishes on a bad key.
 */
export function ConnectionKeyForm({
  type,
  submitLabel,
  onSaved,
  onCancel,
}: ConnectionKeyFormProps) {
  const [secret, setSecret] = useState('');
  const save = useSaveConnectorCredential();
  const inputId = useId();
  const name = providerName(type);

  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = secret.trim();
        if (!trimmed) return;
        save.mutate(
          { provider: type, secret: trimmed },
          {
            onSuccess: () => {
              setSecret('');
              onSaved?.();
            },
          }
        );
      }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={inputId} className="text-xs">
          {name} API key
        </Label>
        <PasswordInput
          id={inputId}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder="Paste your key"
          autoComplete="off"
        />
      </div>
      <div className="flex gap-2">
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!secret.trim() || save.isPending}>
          {save.isPending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
