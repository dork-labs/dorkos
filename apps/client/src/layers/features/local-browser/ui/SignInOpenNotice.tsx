import { Check } from 'lucide-react';
import type { LocalBrowserSignIn } from '@dorkos/shared/local-browser';
import { DONE_SIGNING_IN, SIGN_IN_SAVING, signInOpenLine } from '@/layers/entities/local-browser';
import { Button } from '@/layers/shared/ui';

/** Props for {@link SignInOpenNotice}. */
export interface SignInOpenNoticeProps {
  /** The sign-in window, open or saving. */
  signIn: LocalBrowserSignIn;
  busy: boolean;
  onDone: () => void;
}

/**
 * A sign-in window no card is showing: one a stopped task left open, or one the person
 * opened. Done signing in ends it, so it can never keep the browser stuck (DOR-4731).
 */
export function SignInOpenNotice({ signIn, busy, onDone }: SignInOpenNoticeProps) {
  const saving = signIn.status === 'saving';
  return (
    <div data-slot="sign-in-open-notice" className="flex flex-col gap-2 text-sm">
      <p role="status" aria-live="polite">
        {saving ? SIGN_IN_SAVING : signInOpenLine(signIn.site)}
      </p>
      <Button
        size="sm"
        className="min-h-11 self-start md:min-h-8"
        // Inert while saving, and shown as such, but it stays put so the layout holds.
        disabled={saving || busy}
        aria-disabled={saving || busy}
        onClick={onDone}
      >
        <Check className="size-4" aria-hidden />
        {DONE_SIGNING_IN}
      </Button>
    </div>
  );
}
