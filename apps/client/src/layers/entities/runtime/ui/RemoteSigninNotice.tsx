/**
 * What every surface says to someone who is not on the machine DorkOS runs on.
 *
 * It lives in `entities/runtime` for the same reason `config/login-copy.ts`
 * does, and the argument is that file's verbatim: two features render this —
 * the chat auth-error card (`features/chat`) and the Settings connect flow
 * (`features/runtime-connect`) — and a person who reads one sentence in chat
 * and a different one in Settings has been told the two situations differ when
 * they do not. Neither feature may decide this wording for itself.
 *
 * @module entities/runtime/ui/RemoteSigninNotice
 */
import { RotateCcw } from 'lucide-react';
import { Button } from '@/layers/shared/ui';

/**
 * Tell someone that connecting a runtime has to happen on the machine DorkOS
 * runs on, and what to do about it.
 *
 * Everything that repairs a connection happens there: a sign-in spawns the
 * vendor CLI on that machine, and a pasted key is written to its credential
 * store. Every one of those endpoints is loopback-only, so from anywhere else
 * they are doors onto the same 403 — which is why the surfaces that render this
 * show it INSTEAD of those controls rather than beside them.
 *
 * @param onRetry - Re-run whatever failed, when the calling surface has
 *   something to re-run. Chat does (the failed turn); Settings does not. The
 *   wording follows: it only mentions Retry when there is a Retry to press.
 */
export function RemoteSigninNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <div data-testid="remote-signin-notice">
      <p className="text-muted-foreground text-sm">Signing in needs the computer DorkOS runs on.</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {onRetry
          ? 'Open DorkOS there and sign in, then press Retry here.'
          : 'Open DorkOS there and sign in.'}
      </p>
      {/* The one case the two sentences above get wrong, kept quiet because it
          is the uncommon one: you ARE at that computer, but reached DorkOS by
          its network address instead of localhost. The server sees a Host that
          is not loopback and refuses exactly as it would for a phone, so
          without this line the advice reads as "go to the computer you are
          already sitting at" and leaves no way forward. */}
      <p className="text-muted-foreground/80 mt-2 text-xs">
        Already on that computer? Open DorkOS at localhost instead.
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-3 gap-1.5">
          <RotateCcw className="size-3" />
          Retry
        </Button>
      )}
    </div>
  );
}
