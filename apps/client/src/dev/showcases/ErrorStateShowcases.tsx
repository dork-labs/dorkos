import { useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { toast } from 'sonner';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { RouteErrorFallback } from '@/layers/shared/ui';
import { NotFoundFallback } from '@/layers/shared/ui';
import { AppCrashFallback } from '@/layers/shared/ui';

/**
 * Controlled component that throws when `shouldThrow` is true.
 * Used with ErrorBoundary + resetKeys to demonstrate error/recovery cycle.
 */
function ErrorTrigger({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Controlled showcase error');
  return <p className="text-muted-foreground text-sm">No error — component is healthy.</p>;
}

/** Error state component showcases: RouteErrorFallback, NotFoundFallback, AppCrashFallback, toasts. */
export function ErrorStateShowcases() {
  const [shouldThrow, setShouldThrow] = useState(false);

  return (
    <>
      <PlaygroundSection
        title="Route Error Fallback"
        description="Default error component for route-level errors. Renders inside the app shell — sidebar stays visible."
      >
        <ShowcaseLabel>Interactive — Toggle Error</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-4">
            <button
              className="text-muted-foreground hover:text-foreground w-fit text-xs underline"
              onClick={() => setShouldThrow((prev) => !prev)}
            >
              {shouldThrow ? 'Reset error' : 'Trigger error'}
            </button>
            <div className="border-border/50 min-h-[200px] rounded-lg border">
              <ErrorBoundary
                FallbackComponent={({ error }) => (
                  <RouteErrorFallback
                    error={error instanceof Error ? error : new Error(String(error))}
                    reset={() => setShouldThrow(false)}
                    info={{ componentStack: '' }}
                  />
                )}
                resetKeys={[shouldThrow]}
              >
                <ErrorTrigger shouldThrow={shouldThrow} />
              </ErrorBoundary>
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Not Found Fallback"
        description="Default 404 fallback for structural not-found (URL matches no route)."
      >
        <ShowcaseLabel>Static Preview</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="border-border/50 min-h-[200px] rounded-lg border">
            <NotFoundFallback />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="App Crash Fallback"
        description="Last-resort catastrophic crash fallback. Uses inline styles only — no Tailwind, no shadcn, no app context."
      >
        <ShowcaseLabel>Static Preview</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="min-h-[300px] overflow-hidden rounded-lg">
            <AppCrashFallback
              error={new Error('Example: TransportProvider initialization failed')}
              resetErrorBoundary={() => {}}
            />
          </div>
        </ShowcaseDemo>
        <p className="text-muted-foreground mt-2 text-xs">
          This component uses inline styles only. If context providers crash, any dependency on them
          would also crash — so this fallback has zero bundle dependencies.
        </p>
      </PlaygroundSection>

      <PlaygroundSection
        title="Error Toasts"
        description="Global error notification toasts powered by sonner."
      >
        <ShowcaseLabel>Trigger toasts</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-2">
            <button
              className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
              onClick={() =>
                toast.error("That didn't work. Try again.", {
                  description: "ENOENT: no such file or directory, open '/tmp/example.txt'",
                })
              }
            >
              Mutation error toast
            </button>
            <button
              className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
              onClick={() => toast.error("Couldn't load that. Try again.")}
            >
              Query error toast
            </button>
            <button
              className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
              onClick={() =>
                toast.error('Live updates lost', {
                  description: 'Attempting to reconnect...',
                })
              }
            >
              Toast with description
            </button>
          </div>
        </ShowcaseDemo>
        <p className="text-muted-foreground mt-2 text-xs">
          The mutation toast shows the app-wide shape (DOR-1755): an authored headline and the raw
          error as its <code>description</code>, never joined onto one line. The query toast is the
          plain single-line fallback a query without <code>meta.errorLabel</code> falls back to.
        </p>
        <p className="text-muted-foreground mt-2 text-xs">
          Chat-specific error states (ErrorMessageBlock, including the transport-error variant) are
          showcased on the Chat page.
        </p>
      </PlaygroundSection>
    </>
  );
}
