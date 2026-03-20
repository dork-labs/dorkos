'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';
import { GeistSans } from 'geist/font/sans';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Global error:', error);
    // Capture global error in PostHog
    posthog.captureException(error);
    posthog.capture('global_error', {
      error_message: error.message,
      error_digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className={`${GeistSans.variable} font-sans antialiased`}>
        <div className="flex min-h-screen flex-col items-center justify-center px-4">
          <div className="mx-auto max-w-md space-y-6 text-center">
            <div className="space-y-2">
              <p className="text-7xl font-bold text-neutral-300 dark:text-neutral-700">500</p>
              <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
              <p className="text-neutral-500">An unexpected error occurred. Please try again.</p>
            </div>

            <button
              onClick={() => reset()}
              className="inline-flex h-10 items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus:ring-2 focus:ring-neutral-400 focus:ring-offset-2 focus:outline-none dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
