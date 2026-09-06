import { useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { AlertTriangle, Check, Copy, X } from 'lucide-react';
import { isDynamicImportError } from '@/layers/shared/lib/dynamic-import-error';
import { useCopyFeedback } from '@/layers/shared/lib/use-copy-feedback';
import { cn } from '@/layers/shared/lib/utils';
import { Button } from './button';
import { LinkifiedText } from './linkified-text';

/**
 * Default error fallback for route-level errors.
 *
 * Renders inside the app shell — sidebar and header remain visible.
 * Uses `router.invalidate()` for retry (not `reset()`) because `reset()`
 * does not re-run loaders. See TanStack/router#2539.
 *
 * A stale dynamic-import chunk is the exception: after a rebuild or redeploy the
 * since-deleted chunk 404s, and React caches the rejected module payload, so
 * `router.invalidate()` re-throws instantly. That case offers a full reload
 * instead, which re-fetches the current chunk hashes.
 *
 * Shares one vocabulary with `AppCrashFallback` and `NotFoundFallback` —
 * "Reload DorkOS", "Try again", "Back to home" (DOR-1756 finding 10.4). The
 * headline used to be followed by a raw `error.message` and nothing else, which
 * told a person nothing they could act on; it now leads with an authored
 * sentence and files the raw text under "Details".
 */
export function RouteErrorFallback({ error }: ErrorComponentProps) {
  const router = useRouter();
  const { copied, failed, copy } = useCopyFeedback();
  const staleChunk = isDynamicImportError(error);

  function copyStack() {
    if (!error.stack) return;
    void copy(error.stack);
  }

  function stackCopyIcon() {
    if (copied) return <Check className="size-3 text-green-500" />;
    if (failed) return <X className="text-destructive size-3" />;
    return <Copy className="size-3" />;
  }

  function stackCopyLabel(): string {
    if (copied) return 'Copied!';
    if (failed) return 'Couldn’t copy';
    return 'Copy';
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <AlertTriangle className="text-muted-foreground size-10" />
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-foreground text-lg font-semibold">Something went wrong</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          {staleChunk
            ? 'The app may have updated since you opened this tab. Reloading usually fixes it.'
            : 'This part of DorkOS didn’t load. Try again, or head back home.'}
        </p>
        {/* The raw error goes UNDER the sentence written for the reader, the
            same shape the crash screen uses: it is what a person pastes into a
            bug report, not an explanation. It linkifies; the dev stack trace
            below deliberately does not — its `http://localhost:<port>/src/...`
            entries are source locations, not somewhere to send a person. */}
        {!staleChunk && (
          <>
            <p className="text-muted-foreground/60 mt-2 text-xs">Details</p>
            <p className="text-muted-foreground/80 max-w-md text-xs break-words">
              <LinkifiedText text={error.message} />
            </p>
          </>
        )}
      </div>

      {import.meta.env.DEV && error.stack && (
        <details className="border-border/50 max-w-2xl rounded-md border px-4 py-2">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Stack trace (dev only)
          </summary>
          <div className="relative mt-2">
            <button
              type="button"
              onClick={copyStack}
              title="Copy stack trace"
              className="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-0 right-0 flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
            >
              {stackCopyIcon()}
              <span className={cn(copied && 'text-green-500', failed && 'text-destructive')}>
                {stackCopyLabel()}
              </span>
            </button>
            <pre className="text-muted-foreground overflow-x-auto pr-16 text-xs whitespace-pre-wrap">
              {error.stack}
            </pre>
          </div>
        </details>
      )}

      <div className="flex gap-3">
        {staleChunk ? (
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload DorkOS
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => router.invalidate()}>
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={() => router.navigate({ to: '/' })}>
              Back to home
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
