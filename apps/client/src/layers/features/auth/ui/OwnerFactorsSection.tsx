import { useId, useState, type FormEvent } from 'react';
import QRCode from 'react-qr-code';
import { KeyRound, Smartphone } from 'lucide-react';
import type { OwnerFactor } from '@dorkos/shared/signed-in-devices';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Field,
  FieldLabel,
  Input,
  Skeleton,
} from '@/layers/shared/ui';
import { passkeysAvailable } from '../lib/passkey-ceremony';
import { useOwnerFactors } from '../model/use-owner-factors';
import { SIGN_IN_CHECKS_ID } from './WifiSignInRequests';

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
  // Grouped by the server's own rule: a passkey made for this computer never
  // reads as covering a sign-in from away.
  const away = factors.factors.filter((factor) => factor.worksFromAway);
  const here = factors.factors.filter((factor) => !factor.worksFromAway);

  return (
    <div className="space-y-4" id={SIGN_IN_CHECKS_ID}>
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
          away.map((factor) => (
            <FactorRow
              key={factor.id}
              factor={factor}
              busy={factors.busy}
              isLast={away.length === 1}
              onRemove={() => void factors.remove(factor.id)}
            />
          ))
        )}
        {!factors.isLoading && away.length === 0 && factors.everHadAway && (
          <p className="text-muted-foreground text-xs">
            Other devices can’t sign in until you add one.
          </p>
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
        // Buttons, not rows: an added check and a way to add one never look alike.
        <div className="flex flex-wrap gap-2">
          {canMakePasskey && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void factors.addPasskey()}
              disabled={factors.busy}
            >
              <KeyRound className="mr-1.5 size-3.5" />
              Add a passkey
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void factors.startAuthenticator()}
            disabled={factors.busy}
          >
            <Smartphone className="mr-1.5 size-3.5" />
            Add an authenticator app
          </Button>
        </div>
      )}

      {here.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">On this computer</p>
          {here.map((factor) => (
            <FactorRow
              key={factor.id}
              factor={factor}
              busy={factors.busy}
              isLast={false}
              onRemove={() => void factors.remove(factor.id)}
            />
          ))}
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
  isLast,
  onRemove,
}: {
  factor: OwnerFactor;
  busy: boolean;
  /** Whether removing it leaves no check that works from other devices. */
  isLast: boolean;
  onRemove: () => void;
}) {
  const passkey = factor.kind === 'passkey';
  const Icon = passkey ? KeyRound : Smartphone;
  const name = passkey ? 'Passkey' : 'Authenticator app';
  const added = `added ${new Date(factor.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const meta = [name, passkey ? factor.host : null, added].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <p className="text-sm [overflow-wrap:anywhere]">{meta}</p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${name}`}>
            Remove
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {passkey ? 'Remove this passkey?' : 'Remove this authenticator app?'}
            </AlertDialogTitle>
            {isLast && (
              <AlertDialogDescription>
                Other devices can’t sign in until you add another here.
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRemove} variant="destructive">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
      <p className="text-muted-foreground text-xs">Can’t scan? Enter this key:</p>
      <p className="font-mono text-xs [overflow-wrap:anywhere]">
        {secret.match(/.{1,4}/g)?.join(' ')}
      </p>
      <Field className="gap-1.5">
        <FieldLabel htmlFor={codeId}>Type the 6-digit code it shows.</FieldLabel>
        <Input
          id={codeId}
          inputMode="numeric"
          autoComplete="one-time-code"
          className="w-32 font-mono tracking-widest"
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
