import { useId, useRef, useState, type FormEvent } from 'react';
import { Wifi } from 'lucide-react';
import { Button, Field, FieldLabel, Input, Notice } from '@/layers/shared/ui';
import { useWifiCodeSignIn } from '../model/use-auth-session';
import { CodeGroups } from './CodeGroups';

/**
 * Sign-in on a device reaching DorkOS over the network (DOR-4744). A network sign-in takes no
 * password: the device asks the computer DorkOS runs on, shows a short code
 * to match there, and then takes the one-time code the owner sees after
 * approving. Rendered by the {@link AuthGuard} when the server says so.
 */
export function WifiSignInScreen() {
  const codeId = useId();
  const errorId = useId();
  const [code, setCode] = useState('');
  const codeRef = useRef<HTMLInputElement>(null);
  const signIn = useWifiCodeSignIn();
  const waiting = signIn.step === 'waiting' || signIn.step === 'signing-in';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (signIn.step !== 'waiting' || !code.trim()) return;
    // A refused code stays in the field, selected: a one-character typo is a quick fix.
    if (!(await signIn.finish(code))) codeRef.current?.select();
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-6">
      <div className="bg-card shadow-elevated w-full max-w-sm rounded-xl border p-6">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="bg-muted mb-3 flex size-11 items-center justify-center rounded-full">
            <Wifi className="size-5" />
          </div>
          <h1 className="text-lg font-semibold">Sign in to DorkOS</h1>
          {/* While waiting, the steps below say this again. */}
          {!waiting && (
            <p className="text-muted-foreground mt-1 text-sm">
              This device signs in with a code from the computer DorkOS runs on.
            </p>
          )}
        </div>

        {!waiting ? (
          <Button
            className="w-full"
            onClick={() => void signIn.ask()}
            disabled={signIn.step === 'asking'}
          >
            {signIn.step === 'asking' ? 'Asking…' : signIn.error ? 'Ask again' : 'Ask for a code'}
          </Button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2 text-center">
              <p className="text-sm">
                Open DorkOS on the computer it runs on and approve{' '}
                <span className="font-medium">{signIn.deviceName ?? 'this device'}</span>.
              </p>
              {signIn.matchCode && (
                <div className="space-y-0.5">
                  <p className="text-muted-foreground text-xs">Match code</p>
                  <CodeGroups code={signIn.matchCode} />
                </div>
              )}
              <p className="text-sm">Then type the code it gives you.</p>
            </div>
            <Field className="gap-1.5">
              <FieldLabel htmlFor={codeId}>Code</FieldLabel>
              <Input
                ref={codeRef}
                id={codeId}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                aria-describedby={signIn.error ? errorId : undefined}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Button type="submit" className="w-full" disabled={signIn.step === 'signing-in'}>
              {signIn.step === 'signing-in' ? 'Signing in…' : 'Sign in'}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={signIn.reset}>
              Cancel
            </Button>
          </form>
        )}

        {signIn.error && (
          <Notice id={errorId} tone="error" className="mt-4">
            <p>{signIn.error}</p>
          </Notice>
        )}
      </div>
    </div>
  );
}
