import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { McpClientCredentials } from '@dorkos/shared/transport';
import { Button, Input, Label, PasswordInput } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/** Props for {@link McpClientCredentialsForm}. */
export interface McpClientCredentialsFormProps {
  /** Save the credentials and sign in again with them. */
  onSave: (credentials: McpClientCredentials) => void;
  /** Close the form without saving. */
  onCancel: () => void;
  /** True while the save is on the wire — the controls hold their place, disabled. */
  saving?: boolean;
  /** Applied to the form's root, so a caller can indent it with the rest of the body. */
  className?: string;
}

/**
 * The two fields a person fills in when a provider will not let DorkOS register
 * itself: the app's id, and its secret when the provider issued one (DOR-982).
 *
 * It lives in `entities/agent` beside {@link McpSigninBody} for the same reason
 * that component does: both surfaces that can ask for a sign-in — the managed
 * server card in settings, and the card an agent draws in a conversation — reach
 * this same failure, and the words around a credential a person types must not
 * differ depending on where they were standing.
 *
 * **The secret is write-only.** There is no read side for it anywhere in DorkOS,
 * so nothing here ever displays a saved value: the field starts empty on every
 * open, and the visibility toggle only reveals what the person themselves just
 * typed. Saving clears both fields.
 */
export function McpClientCredentialsForm({
  onSave,
  onCancel,
  saving = false,
  className,
}: McpClientCredentialsFormProps) {
  const fieldId = useId();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const trimmedId = clientId.trim();
  const trimmedSecret = clientSecret.trim();

  return (
    <form
      className={cn('space-y-2', className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmedId || saving) return;
        onSave({ clientId: trimmedId, ...(trimmedSecret ? { clientSecret: trimmedSecret } : {}) });
        setClientId('');
        setClientSecret('');
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${fieldId}-client-id`} className="text-xs">
          Client ID
        </Label>
        <Input
          id={`${fieldId}-client-id`}
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          className="h-8 text-xs"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${fieldId}-client-secret`} className="text-xs">
          Client secret <span className="text-muted-foreground font-normal">(if you got one)</span>
        </Label>
        <PasswordInput
          id={`${fieldId}-client-secret`}
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          autoComplete="off"
          disabled={saving}
          className="h-8 text-xs"
        />
      </div>

      <p className="text-muted-foreground text-xs leading-relaxed">
        From the provider’s developer settings. Stored encrypted on this computer; the agent never
        sees it.
      </p>

      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!trimmedId || saving}
          className="gap-1.5 focus-visible:ring-2"
        >
          {saving && <Loader2 className="size-3 animate-spin" aria-hidden />}
          Save and sign in
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
          className="focus-visible:ring-2"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
