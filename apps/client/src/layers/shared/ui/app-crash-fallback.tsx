import type { CSSProperties } from 'react';
import type { FallbackProps } from 'react-error-boundary';
import { stashPendingFeedback } from '@/layers/shared/lib/pending-feedback';

/**
 * Last-resort crash fallback for catastrophic errors.
 *
 * Uses inline styles only — no shadcn, no Tailwind, no app context.
 * If providers crashed, any dependency on them would also crash.
 *
 * Two recovery actions: a full page reload, and "Report this crash", which
 * stashes a prefilled bug report (message stubbed from the error, stack folded
 * into diagnostics) and reloads — the dialog's host picks it up on the next boot
 * (`shared/lib/pending-feedback.ts`). The dialog itself cannot render here: the
 * whole app tree, its host included, has already unmounted.
 */
export function AppCrashFallback({ error }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  function reportCrash(): void {
    stashPendingFeedback({
      kind: 'bug',
      message: `Crash: ${message}`,
      ...(stack ? { crashStack: stack } : {}),
    });
    window.location.reload();
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100dvh',
        padding: '2rem',
        backgroundColor: '#09090b',
        color: '#d4d4d8',
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      }}
    >
      <p style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
        DorkOS encountered an unexpected error.
      </p>
      <p
        style={{
          fontSize: '0.75rem',
          opacity: 0.6,
          maxWidth: '32rem',
          textAlign: 'center',
        }}
      >
        {message}
      </p>

      {import.meta.env.DEV && stack && (
        <details
          style={{
            marginTop: '1rem',
            maxWidth: '48rem',
            width: '100%',
            border: '1px solid #27272a',
            borderRadius: '0.375rem',
            padding: '0.5rem 1rem',
          }}
        >
          <summary style={{ fontSize: '0.75rem', cursor: 'pointer', opacity: 0.5 }}>
            Stack trace (dev only)
          </summary>
          <pre
            style={{
              fontSize: '0.625rem',
              opacity: 0.4,
              marginTop: '0.5rem',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {stack}
          </pre>
        </details>
      )}

      <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.75rem' }}>
        <button
          type="button"
          onClick={reportCrash}
          style={{ ...CRASH_BUTTON_STYLE, borderColor: '#52525b' }}
          onMouseOver={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#18181b';
          }}
          onFocus={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#18181b';
          }}
          onMouseOut={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
          }}
          onBlur={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
          }}
        >
          Report this crash
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={CRASH_BUTTON_STYLE}
          onMouseOver={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#18181b';
          }}
          onFocus={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#18181b';
          }}
          onMouseOut={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
          }}
          onBlur={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
          }}
        >
          Reload DorkOS
        </button>
      </div>
    </div>
  );
}

/** Shared inline style for the crash-fallback buttons (this file uses no Tailwind). */
const CRASH_BUTTON_STYLE: CSSProperties = {
  padding: '0.5rem 1rem',
  fontSize: '0.875rem',
  backgroundColor: 'transparent',
  color: '#d4d4d8',
  border: '1px solid #3f3f46',
  borderRadius: '0.375rem',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
