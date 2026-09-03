/**
 * What an `auth_error` block offers when a runtime's sign-in dies mid-turn
 * (DOR-1651).
 *
 * Split out of `ErrorMessageBlock` because it is the only part of that block
 * that reaches for data and a router: the error chrome stays a presentational
 * component, and these hooks only run when a sign-in is actually on screen.
 *
 * The split goes one level deeper than it looks. `SessionSigninActions` is
 * where the session-list read lives, and it mounts ONLY when there is a session
 * to read — so the no-session fallback needs neither a QueryClient nor a
 * Transport, which is what lets a bare `<ErrorMessageBlock category="auth_error" />`
 * render anywhere without providers.
 *
 * @module features/chat/ui/message/AuthErrorActions
 */
import { Check, Loader2, LogIn, RotateCcw } from 'lucide-react';
import { runtimeSupportsLogin } from '@dorkos/shared/agent-runtime';
import { Button } from '@/layers/shared/ui';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { getLoginCopy, useDelegateRuntimeLogin } from '@/layers/entities/runtime';
import { useSessions } from '@/layers/entities/session';

/** Settings tab that hosts runtime sign-in — where the quiet fallback link goes. */
const RUNTIMES_SETTINGS_TAB = 'runtimes';

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
 * The login is pinned to the account THIS session is bound to — resolved
 * server-side from the session id, so it is right even for a first turn that
 * failed before writing a transcript. Otherwise a person on a multi-account
 * machine signs into the default account, reads "Signed in", and watches the
 * session keep failing (DOR-1652 built the pin; this is its first caller).
 *
 * Every way the endpoint can refuse — it is loopback-only, and the Obsidian
 * embed declines it outright — arrives as this card's error state with a real
 * message and a retry, so the button is never dead even where it cannot work.
 * Reaching sign-in from a phone or tunnel is DOR-1655.
 */
function InlineSigninActions({
  runtime,
  sessionId,
  onRetry,
  onSigninComplete,
}: {
  runtime: string;
  sessionId: string;
  onRetry?: () => void;
  onSigninComplete?: () => void;
}) {
  // The once-only guarantee is the hook's, not this component's, and it has to
  // be: `isSuccess` is read from the shared MutationCache, which outlives this
  // row. A latch held here would reset on the remount the virtualized
  // transcript performs on every scroll and re-announce a sign-in that already
  // finished — re-sending the failed turn once DOR-1650 consumes this.
  const login = useDelegateRuntimeLogin(runtime, { sessionId, onCompleted: onSigninComplete });
  const copy = getLoginCopy(runtime);

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
      {/* Mounted empty rather than conditionally rendered, so the live region
          exists before its content changes — a region that appears WITH its
          text is not announced by most screen readers. */}
      <p className="text-muted-foreground mb-2 flex items-center gap-2 text-sm" role="status">
        {login.isPending && (
          <>
            <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
            {copy.signInPending}
          </>
        )}
      </p>
      {login.isError && (
        <p className="text-destructive mb-2 text-sm" role="alert">
          {login.errorMessage}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* Stays mounted and disabled while the sign-in runs. Unmounting it
            would dump keyboard focus to <body> mid-flow. */}
        <Button
          size="sm"
          onClick={login.login}
          disabled={login.isPending}
          className="gap-1.5"
          data-testid="auth-error-signin-button"
        >
          <LogIn className="size-3" />
          {login.isError ? 'Try again' : copy.signInLabel}
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
 * "connect" is picking where the model comes from, not logging in — and for
 * every card with no session to sign in for.
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
 * The half that reads data. Mounted only with a session id, so the session-list
 * query — and the QueryClient and Transport it needs — are required only on the
 * path that actually signs in.
 */
function SessionSigninActions({
  sessionId,
  onRetry,
  onSigninComplete,
}: {
  sessionId: string;
  onRetry?: () => void;
  onSigninComplete?: () => void;
}) {
  const { sessions, isLoading } = useSessions();
  const runtime = sessions.find((s) => s.id === sessionId)?.runtime;

  // While the list is still loading the runtime is unknown, not absent —
  // rendering the deep-link now would flip to a Sign in button a moment later.
  // Hold the actions back rather than show one and replace it.
  if (isLoading) return null;
  if (!runtime || !runtimeSupportsLogin(runtime)) {
    return <ProviderPickerActions onRetry={onRetry} />;
  }
  return (
    <InlineSigninActions
      runtime={runtime}
      sessionId={sessionId}
      onRetry={onRetry}
      onSigninComplete={onSigninComplete}
    />
  );
}

/**
 * Actions for an auth error, routed by what the failing runtime can actually
 * do. With no session in context the runtime is unknown, so there is nothing
 * honest to sign into and the deep-link stays — resolved here, before any hook,
 * so that path stays free of data dependencies entirely.
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
  if (!sessionId) return <ProviderPickerActions onRetry={onRetry} />;
  return (
    <SessionSigninActions
      sessionId={sessionId}
      onRetry={onRetry}
      onSigninComplete={onSigninComplete}
    />
  );
}
