import { ArrowUpRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Field, FieldError, FieldLabel, Input } from '@/layers/shared/ui';
import { COLLAPSE_TRANSITION, COLLAPSE_VARIANTS } from '@/layers/shared/lib';

/** Props for the setup view shown when no auth token is configured. */
export interface TunnelSetupProps {
  authToken: string;
  tokenError: string | null;
  onAuthTokenChange: (value: string) => void;
  onSaveToken: () => Promise<void>;
}

/** Setup view — shown when no ngrok auth token is configured. */
export function TunnelSetup({
  authToken,
  tokenError,
  onAuthTokenChange,
  onSaveToken,
}: TunnelSetupProps) {
  return (
    <div data-testid="tunnel-setup" className="space-y-4">
      <p className="text-muted-foreground text-xs leading-relaxed">
        DorkOS opens the tunnel through ngrok, a free tunneling service. Paste your ngrok auth token
        below, a one-time step. If your DorkOS has no owner login yet, you&apos;ll be asked to
        create one before the tunnel starts.
      </p>
      <Field data-invalid={tokenError ? true : undefined}>
        <FieldLabel htmlFor="tunnel-auth-token" className="text-xs font-medium">
          ngrok auth token
        </FieldLabel>
        <Input
          id="tunnel-auth-token"
          type="password"
          placeholder="Paste your ngrok auth token"
          value={authToken}
          onChange={(e) => onAuthTokenChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && authToken.trim()) {
              void onSaveToken();
            }
          }}
          className="text-sm"
        />
        <AnimatePresence>
          {tokenError && (
            <motion.div
              key="token-error"
              variants={COLLAPSE_VARIANTS}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={COLLAPSE_TRANSITION}
              className="overflow-hidden"
            >
              <FieldError>{tokenError}</FieldError>
            </motion.div>
          )}
        </AnimatePresence>
      </Field>

      <Button
        size="sm"
        className="w-full"
        disabled={!authToken.trim()}
        onClick={() => void onSaveToken()}
      >
        Save token
      </Button>

      <p className="text-muted-foreground text-xs">
        Don&apos;t have a token?{' '}
        <a
          href="https://dashboard.ngrok.com/signup"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground group inline-flex items-center gap-0.5 underline underline-offset-2"
        >
          Sign up for ngrok
          <ArrowUpRight className="size-3 transition-transform duration-100 group-hover:-translate-x-0.5" />
        </a>
        . The free tier is enough.
      </p>
    </div>
  );
}
