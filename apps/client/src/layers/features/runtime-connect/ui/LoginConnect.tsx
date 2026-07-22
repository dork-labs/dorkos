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
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, Label, PasswordInput } from '@/layers/shared/ui';
import {
  useDelegateRuntimeLogin,
  useStoreRuntimeCredential,
} from '../model/use-credential-connect';
import { ConnectErrorRow, ConnectProgressRow, ConnectedRow } from './connect-feedback';

/** Per-runtime copy for the login flow — honest, provider-specific wording. */
interface LoginCopy {
  /** Label on the delegated sign-in button. */
  signInLabel: string;
  /** One-line hint under the sign-in button. */
  signInHint: string;
  /** Status line shown while the delegated login is in flight. */
  signInPending: string;
  /** Label above the paste-key input. */
  keyLabel: string;
  /** Placeholder for the key input (a format hint, never a real key). */
  keyPlaceholder: string;
  /** Optional "get a key" link. */
  getKeyUrl?: string;
}

const LOGIN_COPY: Record<string, LoginCopy> = {
  'claude-code': {
    signInLabel: 'Sign in',
    signInHint: 'Use your Claude subscription or Anthropic account.',
    signInPending: 'Waiting for sign-in to complete…',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    getKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  codex: {
    signInLabel: 'Sign in with ChatGPT',
    signInHint: 'Use your ChatGPT account.',
    signInPending: 'Waiting for sign-in to complete…',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    getKeyUrl: 'https://platform.openai.com/api-keys',
  },
};

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
 */
export function LoginConnect({ type }: { type: string }) {
  const copy = LOGIN_COPY[type] ?? LOGIN_COPY['claude-code'];
  const login = useDelegateRuntimeLogin(type);
  const [showKey, setShowKey] = useState(false);

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
          <PasteKeyForm type={type} copy={copy} />
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

/** The paste-key half of the login flow — a password field that never echoes the key. */
function PasteKeyForm({ type, copy }: { type: string; copy: LoginCopy }) {
  const [key, setKey] = useState('');
  const store = useStoreRuntimeCredential(type);

  if (store.isPending) {
    return <ConnectProgressRow message="Saving your API key…" />;
  }
  // On success the whole form (and its password field) unmounts, so the pasted
  // key leaves the DOM entirely — the surface reads "Connected", never the key.
  if (store.isSuccess) {
    return <ConnectedRow />;
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        store.store(key);
      }}
    >
      <Label htmlFor={`api-key-${type}`} className="text-xs">
        {copy.keyLabel}
      </Label>
      <PasswordInput
        id={`api-key-${type}`}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={copy.keyPlaceholder}
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
        <Button type="submit" size="sm" variant="outline" disabled={key.trim().length === 0}>
          Save key
        </Button>
      </div>
    </form>
  );
}
