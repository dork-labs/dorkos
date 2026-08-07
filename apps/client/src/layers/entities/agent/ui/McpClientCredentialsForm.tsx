import { useEffect, useId, useRef, useState } from 'react';
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
  /** Why the last save failed, shown above the buttons. Null when none has. */
  error?: string | null;
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
 * typed.
 *
 * **Nothing is cleared on submit.** A save that fails leaves this form mounted,
 * and clearing the fields as the request went out threw away what the person had
 * typed the moment they most needed it back (DOR-982 review). The success path
 * needs no clearing at all: it restarts the sign-in, which unmounts this form and
 * takes its state with it.
 *
 * Focus moves onto the first field when the form opens, for the same reason it
 * moves onto the custody panel at the disclosure step: the control that was
 * pressed to get here is replaced by this form, so without it focus falls to the
 * document body.
 */
export function McpClientCredentialsForm({
  onSave,
  onCancel,
  saving = false,
  error = null,
  className,
}: McpClientCredentialsFormProps) {
  const fieldId = useId();
  const clientIdRef = useRef<HTMLInputElement>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const trimmedId = clientId.trim();
  const trimmedSecret = clientSecret.trim();

  useEffect(() => {
    clientIdRef.current?.focus();
  }, []);

  return (
    <form
      className={cn('space-y-2', className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmedId || saving) return;
        onSave({ clientId: trimmedId, ...(trimmedSecret ? { clientSecret: trimmedSecret } : {}) });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${fieldId}-client-id`} className="text-xs">
          Client ID
        </Label>
        <Input
          id={`${fieldId}-client-id`}
          ref={clientIdRef}
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

      {error && (
        <p role="alert" className="text-destructive text-xs leading-relaxed">
          {error}
        </p>
      )}

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
