import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { McpSigninFlow } from '../model/use-mcp-signin-flow';
import { McpClientCredentialsForm } from './McpClientCredentialsForm';

/** Props for {@link McpSigninBody}. */
export interface McpSigninBodyProps {
  /** The sign-in state machine this body renders. */
  flow: McpSigninFlow;
  /** The server's name, for the link's accessible label and the success line. */
  serverName: string;
  /** Applied to every block, so a caller can indent the whole body as one. */
  className?: string;
  /** Actions offered once the sign-in failed (e.g. Try again / Dismiss). */
  failedActions?: React.ReactNode;
  /** Actions offered once the sign-in connected (e.g. Dismiss). */
  connectedActions?: React.ReactNode;
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
 * What a connected sign-in says.
 *
 * The tool count is the payoff — it is the difference between "something
 * happened" and "you can now do N things" — but it is optional on the wire, so
 * the sentence degrades to what was always true when it is absent. Never
 * "0 tools" for an unknown count.
 *
 * @param toolCount - Tools the server exposes, or `null` when unreported.
 */
function connectedCopy(toolCount: number | null): string {
  if (toolCount === null) return 'Signed in — the server’s tools are available on the next turn.';
  return `Connected — ${toolCount} tool${toolCount === 1 ? '' : 's'}.`;
}

/**
 * What the trust panel says when the server sent no disclosure of its own.
 *
 * The server always composes one today, so this is the type's tail rather than a
 * path a person is expected to reach — but a custody panel with a blank second
 * line would be worse than any wording, so it carries the founder-approved
 * sentence. It promises only what ships: removing the server is the undo, because
 * there is no sign-out route yet.
 *
 * @param serverName - The provider whose site the person will approve on.
 */
function fallbackCustody(serverName: string): string {
  return `You approve access on ${serverName}'s own site. DorkOS keeps the resulting key here — the agent never sees it, and removing the server removes the key.`;
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
        {connectedCopy(state.toolCount)}
      </p>
    );
  }
  return null;
}

/**
 * The OAuth sign-in surface itself: the server's custody sentence, then the
 * sign-in link (rendered only under the disclosure), a waiting note while
 * polling, and a terminal success or error. Reading order is the consent order —
 * the disclosure sits above the link.
 *
 * **The custody statement is made exactly once, here.** The trust treatment — the
 * shield, the success tint, the bold "stays on this computer" — WRAPS the
 * server's own sentence rather than sitting above it. It was briefly added above
 * instead, and the result was two stacked paragraphs saying nearly the same
 * thing in two different boxes: the duplicate-disclosure pattern DOR-1004
 * removed from the agent's prose for exactly this reason. Because both surfaces
 * that can ask for a sign-in render this component, absorbing it here is what
 * makes "one disclosure" true in the settings card and the chat card alike.
 *
 * ONE component for both places a person can be asked to sign in — the managed
 * server row in settings, and the card an agent draws in the conversation
 * (DOR-1004) — so the words of a consent disclosure cannot differ depending on
 * where a person happened to be standing. It lives in `entities/agent` because
 * that is where the state machine it renders lives, and because two unrelated
 * features consume it; each supplies its own surrounding actions.
 *
 * Two accessibility duties beyond layout. The live region is rendered from
 * `idle` on and is never `display: none` — it is empty, not hidden — so it is in
 * the accessibility tree BEFORE any copy lands in it; a live region inserted (or
 * unhidden) together with its text is not reliably announced. An empty div costs
 * no height, and callers space their lines with margins rather than a gap so the
 * empty region reserves nothing. And when the disclosure arrives, focus moves
 * onto the custody panel: the control the person pressed may unmount at that
 * moment, so without this their focus falls to the document body and the consent
 * text they must read first is never reached. The panel is the focus target
 * rather than the sentence inside it, so the focus ring outlines the one box a
 * person is being asked to read — a ring drawn around the inner paragraph looked
 * like a second, nested disclosure, which is the very thing this surface exists
 * to avoid.
 *
 * A failure leads with the plain reason and keeps the raw OAuth text behind
 * Details (DOR-982). One family gets an extra offer: when the provider will not
 * let DorkOS register itself, the person can paste app credentials they already
 * have and the sign-in restarts with them. The copy stays scoped to what that
 * actually does — it supplies an app identity. It does not promise to fix a
 * provider that rejects the loopback address itself, because DorkOS cannot see
 * that refusal: it happens on the provider's own page, in the person's browser.
 */
export function McpSigninBody({
  flow,
  serverName,
  className,
  failedActions,
  connectedActions,
}: McpSigninBodyProps) {
  const { state } = flow;
  const disclosureRef = useRef<HTMLDivElement>(null);
  const onDisclosure = state.step === 'disclosure';
  const offerRef = useRef<HTMLButtonElement>(null);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  // Kept honest against the flow rather than trusted on its own: the form is for
  // ONE failure family, and a retry that fails a different way (or succeeds)
  // must not leave credential fields sitting under it. A failed SAVE does not
  // close it — that failure is reported inside the form, and the flow's own
  // failure (the thing that says this offer applies) is left standing.
  const showCredentialsForm = credentialsOpen && state.canUseOwnCredentials;

  useEffect(() => {
    if (onDisclosure) disclosureRef.current?.focus();
  }, [onDisclosure]);

  // Cancel puts focus back on the control that opened the form. Without it,
  // dismissing the form drops focus to the document body — the same failure the
  // disclosure step's focus move exists to prevent. Deferred to an effect
  // because the button is remounted by the same state change that hides the form.
  const returningFocus = useRef(false);
  useEffect(() => {
    if (!returningFocus.current || showCredentialsForm) return;
    returningFocus.current = false;
    offerRef.current?.focus();
  }, [showCredentialsForm]);

  return (
    <>
      <div role="status" className={cn('[&:not(:empty)]:mt-1', className)}>
        {politeCopy(flow)}
      </div>

      {onDisclosure && (
        <div className={cn('mt-1 space-y-2', className)}>
          <div
            ref={disclosureRef}
            tabIndex={-1}
            className="border-status-success-border bg-status-success-bg text-status-success-fg flex items-start gap-2 rounded-md border px-3 py-2 focus-visible:ring-2"
          >
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-semibold">Your sign-in stays on this computer.</p>
              <p className="text-xs leading-relaxed">
                {state.disclosure ?? fallbackCustody(serverName)}
              </p>
            </div>
          </div>
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
        <div className={cn('mt-1 space-y-2', className)}>
          <p role="alert" className="text-destructive text-xs leading-relaxed">
            {state.error ?? 'The sign-in did not complete.'}
          </p>
          {state.errorDetail && (
            <details className="text-muted-foreground text-xs">
              <summary className="cursor-pointer focus-visible:ring-2">Details</summary>
              <code className="mt-1 block font-mono text-[11px] break-all">
                {state.errorDetail}
              </code>
            </details>
          )}
          {showCredentialsForm ? (
            <McpClientCredentialsForm
              onSave={(credentials) => flow.useOwnCredentials(credentials)}
              onCancel={() => {
                setCredentialsOpen(false);
                returningFocus.current = true;
              }}
              saving={state.savingCredentials}
              error={state.credentialsError}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              {failedActions}
              {state.canUseOwnCredentials && (
                <Button
                  ref={offerRef}
                  variant="secondary"
                  size="sm"
                  onClick={() => setCredentialsOpen(true)}
                  className="focus-visible:ring-2"
                >
                  Use your own app credentials
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {state.step === 'connected' && connectedActions && (
        <div className={cn('mt-1', className)}>{connectedActions}</div>
      )}
    </>
  );
}
