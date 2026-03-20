'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';
import { Button } from '@/components/ui/button';
import { RefreshCw, Home } from 'lucide-react';
import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Error:', error);
    // Capture error in PostHog
    posthog.captureException(error);
    posthog.capture('client_error', {
      error_message: error.message,
      error_digest: error.digest,
    });
  }, [error]);

  return (
    <div className="container-default flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center py-16">
      <div className="mx-auto max-w-md space-y-6 text-center">
        <div className="space-y-2">
          <p className="text-muted-foreground/30 text-7xl font-bold">500</p>
          <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="text-muted-foreground">An unexpected error occurred. Please try again.</p>
          {error.digest && (
            <p className="text-muted-foreground font-mono text-xs">Error ID: {error.digest}</p>
          )}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button onClick={() => reset()}>
            <RefreshCw className="mr-2 size-4" />
            Try again
          </Button>
          <Button variant="outline" render={<Link href="/" />} nativeButton={false}>
            <Home className="mr-2 size-4" />
            Go home
          </Button>
        </div>
      </div>
    </div>
  );
}
