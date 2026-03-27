import { ArrowUpRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Field, FieldError, FieldLabel, Input } from '@/layers/shared/ui';

/** Height-collapse variants for the token error message. */
const tokenErrorVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

/** Transition for the token error collapse — ease-out avoids spring overshoot on height. */
const tokenErrorTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

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
              variants={tokenErrorVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={tokenErrorTransition}
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
        </a>{' '}
        — free tier is sufficient.
      </p>
    </div>
  );
}
