import { useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { isDynamicImportError } from '@/layers/shared/lib';
import { Button } from './button';

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
 */
export function RouteErrorFallback({ error }: ErrorComponentProps) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const staleChunk = isDynamicImportError(error);

  async function copyStack() {
    if (!error.stack) return;
    await navigator.clipboard.writeText(error.stack);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <AlertTriangle className="text-muted-foreground size-10" />
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-foreground text-lg font-semibold">Something went wrong</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          {staleChunk
            ? 'The app may have updated since you opened this tab. Reloading usually fixes it.'
            : error.message}
        </p>
      </div>

      {import.meta.env.DEV && error.stack && (
        <details className="border-border/50 max-w-2xl rounded-md border px-4 py-2">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Stack trace (dev only)
          </summary>
          <div className="relative mt-2">
            <button
              onClick={copyStack}
              title="Copy stack trace"
              className="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-0 right-0 flex items-center gap-1 rounded px-2 py-1 text-xs transition-all"
            >
              {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
              <span className={copied ? 'text-green-500' : ''}>{copied ? 'Copied!' : 'Copy'}</span>
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
            Reload app
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => router.invalidate()}>
              Retry
            </Button>
            <Button variant="ghost" size="sm" onClick={() => router.navigate({ to: '/' })}>
              Back to Home
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
