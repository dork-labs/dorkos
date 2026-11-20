import { useId, useState, type FormEvent } from 'react';
import { Wifi } from 'lucide-react';
import { Button, Field, FieldLabel, Input, Notice } from '@/layers/shared/ui';
import { useWifiCodeSignIn } from '../model/use-auth-session';
import { CodeGroups } from './CodeGroups';

/**
 * Sign-in on a device reaching DorkOS over Wi-Fi (DOR-4744). Wi-Fi takes no
 * password: the device asks the computer DorkOS runs on, shows a short code
 * to match there, and then takes the one-time code the owner sees after
 * approving. Rendered by the {@link AuthGuard} when the server says so.
 */
export function WifiSignInScreen() {
  const codeId = useId();
  const errorId = useId();
  const [code, setCode] = useState('');
  const signIn = useWifiCodeSignIn();
  const waiting = signIn.step === 'waiting' || signIn.step === 'signing-in';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (signIn.step !== 'waiting' || !code.trim()) return;
    if (!(await signIn.finish(code))) setCode('');
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-6">
      <div className="bg-card shadow-elevated w-full max-w-sm rounded-xl border p-6">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="bg-muted mb-3 flex size-11 items-center justify-center rounded-full">
            <Wifi className="size-5" />
          </div>
          <h1 className="text-lg font-semibold">Sign in to DorkOS</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            On Wi-Fi, this device signs in with a code from the computer DorkOS runs on.
          </p>
        </div>

        {!waiting ? (
          <Button
            className="w-full"
            onClick={() => void signIn.ask()}
            disabled={signIn.step === 'asking'}
          >
            {signIn.step === 'asking' ? 'Asking…' : 'Ask for a code'}
          </Button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2 text-center">
              <p className="text-sm">
                On the computer, approve{' '}
                <span className="font-medium">{signIn.deviceName ?? 'this device'}</span> if it
                shows this code:
              </p>
              {signIn.matchCode && <CodeGroups code={signIn.matchCode} />}
            </div>
            <Field className="gap-1.5">
              <FieldLabel htmlFor={codeId}>Code from the computer</FieldLabel>
              <Input
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
              Start again
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
