/**
 * Codex + Claude terminal-free connect flow (ADR-0318, T1 tasks 2.4/2.5).
 *
 * Two honest choices, no reimplemented vendor OAuth: a delegated CLI sign-in
 * (`claude auth login` / `codex login`) and a native paste-key path. Both flip the
 * runtime to Ready via `['requirements']` invalidation. The key input is a
 * password field, cleared on success — the surface shows "Connected", never the
 * key.
 *
 * @module features/runtime-connect/ui/LoginConnect
 */
import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, Label, PasswordInput } from '@/layers/shared/ui';
import {
  getLoginCopy,
  getRuntimeDescriptor,
  useCheckRuntimeCredential,
  useDelegateRuntimeLogin,
  useRuntimeKeyStatus,
  useStoreRuntimeCredential,
  type LoginCopy,
  type RuntimeConnectSuccess,
} from '@/layers/entities/runtime';
import { loginConnectSuccess } from '../lib/connect-success';
import { ConnectErrorRow, ConnectProgressRow, ConnectedRow } from './connect-feedback';

/**
 * The Codex/Claude connect surface: a delegated sign-in, with a paste-key path
 * one quiet tap away.
 *
 * Sign in is the recommended path, so it is the only thing shown at first — the
 * API-key form stays behind a "Use an API key instead" link to keep the surface
 * calm. The key path is never removed (some people prefer it, or only have a
 * key); it is just deferred until asked for.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param onConnected - Reports the connect landing so the dialog can show its
 *   success moment (omitted where the opener keeps the inline confirmation).
 */
export function LoginConnect({
  type,
  onConnected,
}: {
  type: string;
  onConnected?: (success: RuntimeConnectSuccess) => void;
}) {
  const copy = getLoginCopy(type);
  const login = useDelegateRuntimeLogin(type);
  const [showKey, setShowKey] = useState(false);
  // Fire the landing ONCE. `onConnected` is routinely an inline arrow, so a new
  // identity every render re-runs this effect while `isSuccess` stays true —
  // harmless for a dialog that only shows a success moment, but this callback
  // re-sends turns in DOR-1650's shape, and re-sending a turn is not harmless.
  const reported = useRef(false);

  useEffect(() => {
    if (!login.isSuccess || reported.current) return;
    reported.current = true;
    onConnected?.(loginConnectSuccess(getRuntimeDescriptor(type).label));
  }, [login.isSuccess, onConnected, type]);

  return (
    <div className="space-y-4" data-testid={`login-connect-${type}`}>
      <div className="space-y-2">
        {login.isPending ? (
          <ConnectProgressRow message={copy.signInPending} />
        ) : login.isSuccess ? (
          <ConnectedRow message="Signed in" />
        ) : login.isError ? (
          <ConnectErrorRow
            message={login.errorMessage ?? 'Sign-in failed.'}
            onRetry={login.login}
          />
        ) : (
          <>
            <Button size="sm" className="w-full" onClick={login.login}>
              {copy.signInLabel}
            </Button>
            <p className="text-muted-foreground text-xs">{copy.signInHint}</p>
          </>
        )}
      </div>

      {showKey ? (
        <div className="space-y-3" data-testid={`login-connect-key-${type}`}>
          <div className="flex items-center gap-3">
            <span className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-2xs tracking-wide uppercase">or</span>
            <span className="bg-border h-px flex-1" />
          </div>
          <PasteKeyForm type={type} copy={copy} onConnected={onConnected} />
          <button
            type="button"
            onClick={() => setShowKey(false)}
            className="text-muted-foreground hover:text-foreground text-xs underline decoration-dotted underline-offset-2 transition-colors"
          >
            Back to sign in
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowKey(true)}
          className="text-muted-foreground hover:text-foreground text-xs underline decoration-dotted underline-offset-2 transition-colors"
          data-testid={`login-connect-use-key-${type}`}
        >
          Use an API key instead
        </button>
      )}
    </div>
  );
}

/**
 * The paste-key half of the login flow — a password field that never echoes the
 * key.
 *
 * The key is tried against the service that issues it before anything is saved,
 * a Test button tries it on demand, and a key that is already saved says so by
 * its last four characters instead of showing an empty field that reads as
 * "nothing is connected" (DOR-2123). Codex never shows that hint, and that is
 * the truth rather than a gap: its key is written to Codex's own login store,
 * so DorkOS holds no copy to describe.
 */
function PasteKeyForm({
  type,
  copy,
  onConnected,
}: {
  type: string;
  copy: LoginCopy;
  onConnected?: (success: RuntimeConnectSuccess) => void;
}) {
  const [key, setKey] = useState('');
  const store = useStoreRuntimeCredential(type);
  const status = useRuntimeKeyStatus(type);
  const test = useCheckRuntimeCredential(type);
  // Once only, for the same reason the sign-in half latches (see above).
  const reported = useRef(false);
  const keyField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!store.isSuccess || reported.current) return;
    reported.current = true;
    onConnected?.(loginConnectSuccess(getRuntimeDescriptor(type).label));
  }, [store.isSuccess, onConnected, type]);

  // Put the cursor back where the fix happens — a refusal is almost always a
  // mistyped key.
  useEffect(() => {
    if (store.isError) keyField.current?.focus();
  }, [store.isError]);

  // On success the whole form (and its password field) unmounts, so the pasted
  // key leaves the DOM entirely — the surface reads "Connected", never the key.
  if (store.isSuccess) {
    return <ConnectedRow />;
  }

  const saved = status.data?.key.saved ? status.data.key : null;
  const hasKey = key.trim().length > 0;
  // Read-only while EITHER request is in flight — a Test's answer is about the
  // field as it stood when it was sent, so editing mid-flight would leave an
  // answer on screen about a key that is no longer there. The form STAYS on
  // screen either way: swapping it for a spinner collapses the panel and throws
  // the scroll to the top, so the refusal that comes back lands off-screen.
  const busy = store.isPending || test.isPending;
  /** Drop a stale answer the moment the key it was about changes. */
  const invalidateAnswers = () => {
    test.reset();
    store.reset();
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        // One message at a time: a save's answer replaces a test's.
        test.reset();
        store.store(key);
      }}
    >
      <Label htmlFor={`api-key-${type}`} className="text-xs">
        {copy.keyLabel}
      </Label>
      <PasswordInput
        id={`api-key-${type}`}
        ref={keyField}
        value={key}
        disabled={busy}
        onChange={(e) => {
          setKey(e.target.value);
          invalidateAnswers();
        }}
        placeholder={
          saved
            ? `Saved · ends in ${saved.last4} — paste a new key to replace it`
            : copy.keyPlaceholder
        }
        autoComplete="off"
        spellCheck={false}
      />
      {store.isError && (
        <p className="text-destructive text-xs" role="alert">
          {store.errorMessage}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        {copy.getKeyUrl ? (
          <a
            href={copy.getKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
          >
            Get an API key <ExternalLink className="size-3" />
          </a>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={(!hasKey && saved === null) || busy}
            data-testid={`api-key-test-${type}`}
            onClick={() => {
              // One message at a time, in both directions.
              store.reset();
              test.reset();
              test.check(key);
            }}
          >
            Test key
          </Button>
          <Button type="submit" size="sm" variant="outline" disabled={!hasKey || busy}>
            Save key
          </Button>
        </div>
      </div>
      {/* One slot for every answer, and the form never leaves the page to show
          one — see DirectProviderPath for the scroll-jump this avoids. */}
      {busy ? (
        <ConnectProgressRow message={store.phase === 'saving' ? 'Saving…' : 'Checking your key…'} />
      ) : test.result?.ok === true ? (
        // Say WHICH key works: with a blank field the answer is about the key
        // already saved, not about what is on screen.
        <ConnectedRow message={test.checkedSavedKey ? 'Your saved key works' : 'Key works'} />
      ) : test.result ? (
        // A plain line, not a row with a Retry button: there is nothing to retry
        // blindly — the key is fixed in the field above, then Test again.
        <p className="text-destructive text-xs" role="alert">
          {test.result.message}
        </p>
      ) : null}
    </form>
  );
}
