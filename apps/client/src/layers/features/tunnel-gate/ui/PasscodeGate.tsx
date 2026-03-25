import { useState, useCallback } from 'react';
import { DorkLogo } from '@dorkos/icons/logos';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/layers/shared/ui/input-otp';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { useTransport } from '@/layers/shared/model';

interface PasscodeGateProps {
  onSuccess: () => void;
}

/**
 * Full-screen passcode entry gate for remote tunnel access.
 *
 * Renders a 6-digit OTP input with DorkOS branding. On completion,
 * verifies the passcode against the server. On failure, clears the input
 * and shows an error. Calls `onSuccess` when the passcode is accepted.
 */
export function PasscodeGate({ onSuccess }: PasscodeGateProps) {
  const transport = useTransport();
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [value, setValue] = useState('');

  const handleComplete = useCallback(
    async (passcode: string) => {
      setIsVerifying(true);
      setError(null);

      try {
        const result = await transport.verifyTunnelPasscode(passcode);
        if (result.ok) {
          onSuccess();
        } else {
          const msg = result.retryAfter
            ? `Too many attempts. Try again in ${Math.ceil(result.retryAfter / 60)} minutes.`
            : (result.error ?? 'Incorrect passcode');
          setError(msg);
          setValue('');
        }
      } catch {
        setError('Connection error. Try again.');
        setValue('');
      } finally {
        setIsVerifying(false);
      }
    },
    [transport, onSuccess]
  );

  return (
    <div className="bg-background flex min-h-dvh items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <DorkLogo variant="white" size={120} />

        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-foreground text-lg font-semibold">Enter passcode</h1>
          <p className="text-muted-foreground text-sm">
            Enter your 6-digit passcode to access this instance.
          </p>
        </div>

        <InputOTP
          maxLength={6}
          pattern={REGEXP_ONLY_DIGITS}
          inputMode="numeric"
          value={value}
          onChange={setValue}
          onComplete={handleComplete}
          disabled={isVerifying}
          autoFocus
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <InputOTPSlot key={i} index={i} className={error ? 'border-destructive' : ''} />
            ))}
          </InputOTPGroup>
        </InputOTP>

        {error && <p className="text-destructive text-sm">{error}</p>}

        {isVerifying && <p className="text-muted-foreground text-sm">Verifying...</p>}
      </div>
    </div>
  );
}
