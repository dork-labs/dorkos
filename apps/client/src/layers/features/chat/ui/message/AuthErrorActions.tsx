/**
 * What an `auth_error` block offers when a runtime's sign-in dies mid-turn
 * (DOR-1651).
 *
 * Split out of `ErrorMessageBlock` because it is the only part of that block
 * that reaches for data and a router: the error chrome stays a presentational
 * component, and these hooks only run when a sign-in is actually on screen.
 *
 * @module features/chat/ui/message/AuthErrorActions
 */
import { useEffect } from 'react';
import { Check, Loader2, LogIn, RotateCcw } from 'lucide-react';
import { runtimeAuthConnectKind } from '@dorkos/shared/agent-runtime';
import { Button } from '@/layers/shared/ui';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { useDelegateRuntimeLogin } from '@/layers/entities/runtime';
import { useSessions } from '@/layers/entities/session';

/** Settings tab that hosts runtime sign-in — where the quiet fallback link goes. */
const RUNTIMES_SETTINGS_TAB = 'runtimes';

/**
 * The runtime whose account pin the login endpoint accepts. Only Claude Code
 * keeps per-account config directories; the server rejects the pin for anything
 * else, so sending it elsewhere would turn a working sign-in into an error.
 */
const ACCOUNT_PINNED_RUNTIME = 'claude-code';

/** The quiet link under the auth actions — one destination, named by what it gets you. */
function SettingsFallbackLink({ label }: { label: string }) {
  const { open: openSettings } = useSettingsDeepLink();
  return (
    <button
      type="button"
      onClick={() => openSettings(RUNTIMES_SETTINGS_TAB)}
      className="text-muted-foreground hover:text-foreground mt-2 block text-xs underline decoration-dotted underline-offset-2 transition-colors"
    >
      {label}
    </button>
  );
}

/**
 * Auth-error actions for a runtime that signs in — Claude Code and Codex.
 *
 * The sign-in runs HERE, in the conversation, instead of sending the person to
 * Settings → Runtimes to find the right card and press Reconnect. That detour
 * was four steps deep at the exact moment someone was mid-thought, and the
 * inline card is the same pattern an OAuth-protected MCP server already gets.
 *
 * The login is pinned to the account THIS session is bound to, so on a machine
 * with more than one Claude account the person does not sign into the default
 * one, read "Signed in", and watch the session keep failing (DOR-1652 built the
 * pin; this is its first caller).
 *
 * Every way the endpoint can refuse — it is loopback-only, and the Obsidian
 * embed declines it outright — arrives as this card's error state with a real
 * message and a retry, so the button is never dead even where it cannot work.
 * Reaching sign-in from a phone or tunnel is DOR-1655.
 */
function InlineSigninActions({
  runtime,
  accountRoot,
  onRetry,
  onSigninComplete,
}: {
  runtime: string;
  accountRoot: string | undefined;
  onRetry?: () => void;
  onSigninComplete?: () => void;
}) {
  const login = useDelegateRuntimeLogin(
    runtime,
    // Only Claude Code accepts the pin; sending it for Codex is a hard refusal.
    runtime === ACCOUNT_PINNED_RUNTIME && accountRoot !== undefined ? { accountRoot } : undefined
  );

  useEffect(() => {
    // The seam DOR-1650 (auto-resume) picks up: a completed sign-in is exactly
    // the moment the failed turn can be re-sent for the person. Nothing passes
    // this yet — today they press Retry themselves.
    if (login.isSuccess) onSigninComplete?.();
  }, [login.isSuccess, onSigninComplete]);

  if (login.isPending) {
    return (
      <div
        className="text-muted-foreground mt-3 flex items-center gap-2 text-sm"
        data-testid="auth-error-signin-pending"
        // The sign-in happens in another window; a spinner alone leaves a
        // screen-reader user with no idea anything started.
        role="status"
      >
        <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
        Waiting for sign-in to complete…
      </div>
    );
  }

  if (login.isSuccess) {
    return (
      <div className="mt-3" data-testid="auth-error-signin-success">
        <p
          className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-500"
          role="status"
        >
          <Check aria-hidden="true" className="size-3.5 shrink-0" />
          Signed in.
        </p>
        {onRetry && (
          <Button size="sm" onClick={onRetry} className="mt-2 gap-1.5">
            <RotateCcw className="size-3" />
            Retry
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3" data-testid="auth-error-signin">
      {login.isError && (
        <p className="text-destructive mb-2 text-sm" role="alert">
          {login.errorMessage}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={login.login} className="gap-1.5">
          <LogIn className="size-3" />
          {login.isError ? 'Try again' : 'Sign in'}
        </Button>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
            <RotateCcw className="size-3" />
            Retry
          </Button>
        )}
      </div>
      {/* One quiet way out, not two. The key form lives in Settings → Runtimes,
          so the link that goes there is named for what the person wants rather
          than for the screen it opens. */}
      <SettingsFallbackLink label="Use an API key instead" />
    </div>
  );
}

/**
 * Auth-error actions for a runtime with no sign-in to run — OpenCode, whose
 * "connect" is picking where the model comes from, not logging in. Signing in
 * inline would be a lie, so this keeps the deep-link to the picker.
 */
function ProviderPickerActions({ onRetry }: { onRetry?: () => void }) {
  const { open: openSettings } = useSettingsDeepLink();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => openSettings(RUNTIMES_SETTINGS_TAB)} className="gap-1.5">
        <LogIn className="size-3" />
        Fix sign-in
      </Button>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
          <RotateCcw className="size-3" />
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * Actions for an auth error, routed by what the failing runtime can actually
 * do. Extracted so the router- and session-backed hooks are only invoked for
 * auth errors — non-auth error blocks stay router- and data-independent.
 *
 * With no session in context the runtime is unknown, so there is nothing
 * honest to sign into and the deep-link stays.
 */
export function AuthErrorActions({
  sessionId,
  onRetry,
  onSigninComplete,
}: {
  /** Session that failed — names the runtime and the account to sign into. */
  sessionId?: string;
  /** Re-send the failed turn. Omitted when there is nothing to resend. */
  onRetry?: () => void;
  /** Fires once a sign-in started here completes (the DOR-1650 seam). */
  onSigninComplete?: () => void;
}) {
  // Both facts come off the same server-authoritative session row, so they are
  // read in one lookup: which runtime failed, and which account that session is
  // bound to. `account` is set only for runtimes that have accounts at all.
  const { sessions } = useSessions();
  const row = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const runtime = row?.runtime;
  const accountRoot = row?.account;

  if (!runtime || runtimeAuthConnectKind(runtime) !== 'login') {
    return <ProviderPickerActions onRetry={onRetry} />;
  }
  return (
    <InlineSigninActions
      runtime={runtime}
      accountRoot={accountRoot}
      onRetry={onRetry}
      onSigninComplete={onSigninComplete}
    />
  );
}
