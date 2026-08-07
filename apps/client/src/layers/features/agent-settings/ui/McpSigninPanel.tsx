import { useEffect, useRef } from 'react';
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import type { McpSigninFlow } from '@/layers/entities/agent';

/** Props for {@link McpSigninPanel}. */
export interface McpSigninPanelProps {
  /** The sign-in state machine for this server. */
  flow: McpSigninFlow;
  /** The server's name, for the link's accessible label. */
  serverName: string;
}

/** The spinner-plus-copy shape the two in-flight steps share. */
function WorkingLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-xs">
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {children}
    </p>
  );
}

/**
 * The copy the polite live region announces for the steps that have no control
 * of their own to move focus to. `null` for `idle`, and for the two steps that
 * own their own announcement: `disclosure` (focus moves onto it) and `failed`
 * (an `alert`).
 *
 * @param flow - The sign-in state machine.
 */
function politeCopy(flow: McpSigninFlow): React.ReactNode {
  const { state } = flow;
  if (state.step === 'starting') return <WorkingLine>Starting sign-in…</WorkingLine>;
  if (state.step === 'waiting') {
    return (
      <div className="space-y-1">
        <WorkingLine>
          Waiting for you to finish signing in… You can close the tab when done.
        </WorkingLine>
        {state.retryNotice && <p className="text-muted-foreground text-xs">{state.retryNotice}</p>}
      </div>
    );
  }
  if (state.step === 'connected') {
    return (
      <p className="flex items-center gap-2 text-xs text-green-600 dark:text-green-500">
        <CheckCircle2 className="size-3.5" aria-hidden />
        Signed in — the server’s tools are available on the next turn.
      </p>
    );
  }
  return null;
}

/**
 * The inline OAuth sign-in surface under a managed row: the server's custody
 * sentence, then the sign-in link (opened only after the disclosure is on
 * screen), a waiting note while polling, and a terminal success or error.
 * Reading order is the consent order — the disclosure sits above the link.
 *
 * Two accessibility duties beyond layout. The live region is rendered from
 * `idle` on and is never `display: none` — it is empty, not hidden — so it is in
 * the accessibility tree BEFORE any copy lands in it; a live region inserted (or
 * unhidden) together with its text is not reliably announced. An empty div costs
 * no height, and the row deliberately spaces its lines with margins rather than
 * a gap so the empty region reserves nothing. And when the disclosure arrives,
 * focus moves onto the custody sentence: the button the person pressed unmounts
 * at that moment, so without this their focus falls to the document body and the
 * consent text they must read first is never reached.
 */
export function McpSigninPanel({ flow, serverName }: McpSigninPanelProps) {
  const { state } = flow;
  const disclosureRef = useRef<HTMLParagraphElement>(null);
  const onDisclosure = state.step === 'disclosure';

  useEffect(() => {
    if (onDisclosure) disclosureRef.current?.focus();
  }, [onDisclosure]);

  return (
    <>
      <div role="status" className="pl-4 [&:not(:empty)]:mt-1">
        {politeCopy(flow)}
      </div>

      {onDisclosure && (
        <div className="mt-1 space-y-2 pl-4">
          <p
            ref={disclosureRef}
            tabIndex={-1}
            className="bg-muted rounded-md px-3 py-2 text-xs leading-relaxed focus-visible:ring-2"
          >
            {state.disclosure}
          </p>
          {state.authorizeUrl && (
            <Button asChild size="sm" className="gap-1.5 focus-visible:ring-2">
              <a
                href={state.authorizeUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => flow.authOpened()}
                aria-label={`Open the sign-in page for ${serverName}`}
              >
                Open the sign-in page
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </Button>
          )}
        </div>
      )}

      {state.step === 'failed' && (
        <div className="mt-1 space-y-2 pl-4">
          <p role="alert" className="text-destructive text-xs leading-relaxed">
            {state.error ?? 'The sign-in did not complete.'}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => flow.start()}
              className="focus-visible:ring-2"
            >
              Try again
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => flow.reset()}
              className="focus-visible:ring-2"
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {state.step === 'connected' && (
        <div className="mt-1 pl-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => flow.reset()}
            className="focus-visible:ring-2"
          >
            Dismiss
          </Button>
        </div>
      )}
    </>
  );
}
