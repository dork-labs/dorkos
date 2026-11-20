import { useId, useState, type FormEvent } from 'react';
import QRCode from 'react-qr-code';
import { KeyRound, Smartphone } from 'lucide-react';
import type { OwnerFactor } from '@dorkos/shared/signed-in-devices';
import { Button, Field, FieldLabel, Input, Skeleton } from '@/layers/shared/ui';
import { passkeysAvailable } from '../lib/passkey-ceremony';
import { useOwnerFactors } from '../model/use-owner-factors';

/**
 * Settings › Login & security › Signing in from other devices (DOR-3647): the
 * owner's passkeys and authenticator apps. Once one is set up, a sign-in from
 * another device needs it beside the password; this computer never asks.
 * Shown only to the owner in person.
 */
export function OwnerFactorsSection() {
  const factors = useOwnerFactors(true);
  const canMakePasskey = passkeysAvailable();
  if (factors.unavailable) return null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="text-muted-foreground size-4" />
          <p className="text-sm font-medium">Signing in from other devices</p>
        </div>
        <p className="text-muted-foreground text-xs">
          Asked when you sign in from another device. Never at this computer.
        </p>
      </div>

      <div className="space-y-1.5">
        {factors.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          factors.factors.map((factor) => (
            <FactorRow
              key={factor.id}
              factor={factor}
              busy={factors.busy}
              onRemove={() => void factors.remove(factor.id)}
            />
          ))
        )}
      </div>

      {factors.pending ? (
        <AuthenticatorSetup
          uri={factors.pending.uri}
          secret={factors.pending.secret}
          busy={factors.busy}
          onConfirm={factors.confirmAuthenticator}
          onCancel={factors.cancelAuthenticator}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {canMakePasskey && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void factors.addPasskey()}
              disabled={factors.busy}
            >
              Add a passkey
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void factors.startAuthenticator()}
            disabled={factors.busy}
          >
            Add an authenticator app
          </Button>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Lost it? Sign in on the computer DorkOS runs on and remove it.
      </p>

      {factors.error && (
        <p className="text-destructive text-xs" role="alert">
          {factors.error}
        </p>
      )}
    </div>
  );
}

function FactorRow({
  factor,
  busy,
  onRemove,
}: {
  factor: OwnerFactor;
  busy: boolean;
  onRemove: () => void;
}) {
  const Icon = factor.kind === 'passkey' ? KeyRound : Smartphone;
  const detail = factor.kind === 'passkey' && factor.host ? `Works on ${factor.host}` : null;
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{factor.label}</p>
          {detail && <p className="text-muted-foreground truncate text-xs">{detail}</p>}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove ${factor.label}`}
      >
        Remove
      </Button>
    </div>
  );
}

function AuthenticatorSetup({
  uri,
  secret,
  busy,
  onConfirm,
  onCancel,
}: {
  uri: string;
  secret: string;
  busy: boolean;
  onConfirm: (code: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const codeId = useId();
  const [code, setCode] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!(await onConfirm(code))) setCode('');
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-md border p-3">
      <p className="text-sm">Scan this with your authenticator app.</p>
      {/* White in both themes: a camera needs dark modules on a light field. */}
      <div className="flex justify-center rounded-lg bg-white p-3">
        <QRCode value={uri} size={160} level="M" />
      </div>
      <p className="text-muted-foreground text-xs break-all">
        Or type this key: <span className="font-mono">{secret}</span>
      </p>
      <Field className="gap-1.5">
        <FieldLabel htmlFor={codeId}>The 6-digit code it shows</FieldLabel>
        <Input
          id={codeId}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          Confirm
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
