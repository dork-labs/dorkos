import { useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, X } from 'lucide-react';
import { DorkLogo } from '@dorkos/icons/logos';
import { openLink, useCopyFeedback } from '@/layers/shared/lib';
import { Button, Spinner } from '@/layers/shared/ui';
import { approvalUrl } from '../lib/approval-url';
import type { FirstRunAccountLink, FirstRunPendingCode } from '../model/first-run-slots';
import type { DorkosConnectPhase } from '../model/use-dorkos-connect';

interface ConnectingStepProps {
  /** What the DorkOS path is doing now. */
  phase: DorkosConnectPhase;
  /** The account link, for the billing page. `null` where none was lent. */
  link: FirstRunAccountLink | null;
  /** Ask for a new code, or try the whole path again. Called from the click. */
  onRetry: () => void;
  /** Stop: cancel the code and go back to Welcome. */
  onCancel: () => void;
  /** Take the Own AI path instead. */
  onUseOwnAi: () => void;
}

/**
 * Continue with DorkOS, while the person finishes in the browser (spec
 * `one-minute-onboarding` §2.2).
 *
 * The approval page opened in a new tab when they pressed Continue, with the
 * code filled in. This screen is the fallback for a tab that was blocked or
 * closed: the code, a Copy button, the page again, and the address as text.
 * It moves on by itself once the account is ready; nothing here needs a click
 * on the happy path.
 */
export function ConnectingStep({
  phase,
  link,
  onRetry,
  onCancel,
  onUseOwnAi,
}: ConnectingStepProps) {
  return (
    <div
      className="mx-auto flex w-full max-w-sm flex-col items-center px-4 text-center"
      data-testid="onboarding-connecting"
      data-phase={phase.kind}
    >
      <DorkLogo size={72} className="mb-6 opacity-90 dark:hidden" />
      <DorkLogo variant="white" size={72} className="mb-6 hidden opacity-90 dark:block" />
      <PhaseBody phase={phase} link={link} onRetry={onRetry} onUseOwnAi={onUseOwnAi} />
      <Button variant="ghost" size="sm" className="text-muted-foreground mt-8" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** The heading, the line under it, and what the phase offers. */
function PhaseBody({ phase, link, onRetry, onUseOwnAi }: Omit<ConnectingStepProps, 'onCancel'>) {
  switch (phase.kind) {
    case 'starting':
      return <Waiting heading="Finish in your browser." line="Opening the DorkOS page…" />;
    case 'waiting':
      return (
        <>
          <Heading>Finish in your browser.</Heading>
          <Line>Sign in, then come back. This screen moves on by itself.</Line>
          <PendingCode pending={phase.pending} />
        </>
      );
    case 'finishing':
      return <Waiting heading="Signed in." line="Getting your account ready…" />;
    case 'needs-card':
      return (
        <>
          <Heading>Add a card to finish.</Heading>
          <Line>Your agents start once a card is saved.</Line>
          <Button
            className="mt-6"
            onClick={() => link?.openBilling()}
            disabled={!link || link.billingPending}
          >
            {link?.billingPending && <Spinner size="xs" />}
            Add a card
          </Button>
          {link?.billingNotice && <ErrorLine>{link.billingNotice}</ErrorLine>}
        </>
      );
    case 'refused':
      return (
        <>
          <Heading>Paid plans are US only.</Heading>
          <Line>Use your own AI instead.</Line>
          <Button className="mt-6" onClick={onUseOwnAi}>
            Use my own AI
          </Button>
        </>
      );
    case 'expired':
      return (
        <>
          <Heading>Your code expired.</Heading>
          <Line>Get a new one to finish signing in.</Line>
          <Button className="mt-6" onClick={onRetry}>
            Get a new code
          </Button>
        </>
      );
    case 'failed':
      return (
        <>
          <Heading>Couldn’t start signing in.</Heading>
          <ErrorLine>{phase.message}</ErrorLine>
          <Button className="mt-6" onClick={onRetry}>
            Try again
          </Button>
        </>
      );
  }
}

/** A heading with a spinner line, for the phases that only wait. */
function Waiting({ heading, line }: { heading: string; line: string }) {
  return (
    <>
      <Heading>{heading}</Heading>
      <p className="text-muted-foreground mt-3 flex items-center gap-2 text-sm" role="status">
        <Spinner size="xs" />
        {line}
      </p>
    </>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h1 className="text-2xl font-semibold tracking-tight text-balance">{children}</h1>;
}

function Line({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground mt-3 text-sm text-balance">{children}</p>;
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="text-destructive mt-3 text-sm text-balance" role="alert">
      {children}
    </p>
  );
}

/**
 * The fallback for a blocked or closed tab: the code to copy, the page to
 * open again, and its address as text for a browser on another device.
 */
function PendingCode({ pending }: { pending: FirstRunPendingCode }) {
  const { copied, failed, copy } = useCopyFeedback();
  const [openFailed, setOpenFailed] = useState(false);
  const url = approvalUrl(pending);

  return (
    <div className="mt-8 w-full space-y-4" data-testid="onboarding-link-code">
      <div className="flex items-center gap-2">
        <code className="bg-muted flex-1 rounded-md px-4 py-3 text-center font-mono text-xl font-semibold tracking-[0.2em] tabular-nums">
          {pending.userCode}
        </code>
        <Button
          variant="ghost"
          size="icon-md"
          onClick={() => void copy(pending.userCode)}
          aria-label={failed ? 'Couldn’t copy code. Try again' : 'Copy code'}
        >
          {copied ? (
            <Check className="text-status-success size-4" />
          ) : failed ? (
            <X className="text-destructive size-4" />
          ) : (
            <Copy className="size-4" />
          )}
        </Button>
      </div>
      <Button
        variant="outline"
        className="w-full"
        disabled={url === null}
        onClick={() => setOpenFailed(url === null || !openLink(url))}
      >
        <ExternalLink className="size-4" />
        Open the page again
      </Button>
      <p className="text-muted-foreground text-xs break-all">{pending.verificationUri}</p>
      {openFailed && <ErrorLine>Couldn’t open the page. Copy the code instead.</ErrorLine>}
      <p className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
        <Spinner size="xs" />
        <span role="status">Waiting for you to approve.</span>
      </p>
    </div>
  );
}
