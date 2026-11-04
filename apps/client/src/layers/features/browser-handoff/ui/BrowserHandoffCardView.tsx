import { Hand, KeyRound, LogIn, Monitor, Play } from 'lucide-react';
import { shortenHomePath } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import type { HandoffStep } from '../lib/handoff-step';

/** Props for {@link BrowserHandoffCardView}. */
export interface BrowserHandoffCardViewProps {
  /** The host the agent's page was on when it asked. */
  site: string;
  /** The asking agent's name, or null when the call carried no identity. */
  agentName: string | null;
  /** The asking agent's folder. Agents choose their own names, so this says which one it is. */
  agentFolder: string | null;
  step: HandoffStep;
  /** Whether the agent's own window can be raised. */
  canShowWindow: boolean;
  /** A button's call is running. */
  busy: boolean;
  error: string | null;
  onContinue: () => void;
  onSignIn: () => void;
  onShowWindow: () => void;
  onStop: () => void;
}

/** The most of an agent's name a card shows. An agent picks its own name. */
const MAX_AGENT_NAME = 40;

/** The status line for each step of the plain sign-in window. */
function signInStatus(step: HandoffStep, site: string): string | null {
  if (step === 'sign-in-open') return 'Sign-in window open. Sign in, then close the window.';
  if (step === 'saving') return 'Saving your sign-in…';
  if (step === 'saved') return `Signed in to ${site}.`;
  if (step === 'failed') return 'Couldn’t save your sign-in. Try again.';
  return null;
}

/**
 * "<site> wants a person to continue". One card for every place a handoff shows,
 * drawn by DorkOS and outside the page, so neither the page nor the agent can fake
 * it or press its buttons. Every word about the site comes from the page's real
 * host, never from the agent. Pure, so the Dev Playground can show each step.
 */
export function BrowserHandoffCardView({
  site,
  agentName,
  agentFolder,
  step,
  canShowWindow,
  busy,
  error,
  onContinue,
  onSignIn,
  onShowWindow,
  onStop,
}: BrowserHandoffCardViewProps) {
  // An agent picks its own name, and control or direction characters could reorder the sentence.
  const whole = agentName?.replace(/[\p{Cc}\p{Cf}]/gu, '') || 'The agent';
  const name = whole.length > MAX_AGENT_NAME ? `${whole.slice(0, MAX_AGENT_NAME)}…` : whole;
  const asksPassword = step === 'sign-in' || step === 'failed';
  const status = signInStatus(step, site);
  const canContinue = step === 'wall' || step === 'saved';
  return (
    <section
      aria-label={`${site} wants a person to continue`}
      data-slot="browser-handoff-card"
      className="bg-card mb-2 flex flex-col gap-3 rounded-xl border p-3 text-sm"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
          <Hand className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="font-medium break-words">{site} wants a person to continue</h3>
          <p className="text-muted-foreground text-xs">
            Agent browser · <span className="text-status-warning-fg">{name} is paused</span>
          </p>
          {agentFolder && (
            <p className="text-muted-foreground font-mono text-xs break-all">
              {shortenHomePath(agentFolder)}
            </p>
          )}
        </div>
      </div>
      {step === 'wall' && (
        <div className="space-y-1">
          <p>The site asked for a check only a person can do.</p>
          <p className="text-muted-foreground">It isn’t anything you did.</p>
          <p className="text-muted-foreground">
            Finish it in the window, then come back and press Continue.
          </p>
        </div>
      )}
      {step === 'panel-sign-in' && (
        <div className="space-y-1">
          <p>This page asks for a password. Don’t type it in this panel.</p>
          <p className="text-muted-foreground">Signing in isn’t available from the panel yet.</p>
        </div>
      )}
      {asksPassword && (
        <div className="bg-muted/50 flex gap-2 rounded-md p-2">
          <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p>This page asks for a password. Sign in from a plain window instead.</p>
            <p className="text-muted-foreground">Don’t type it in {name}’s window.</p>
          </div>
        </div>
      )}
      {step === 'sign-in' && (
        <p className="text-muted-foreground">
          The window opens for you only. Close it when you’re signed in.
        </p>
      )}
      {status && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {asksPassword && (
          <Button disabled={busy} onClick={onSignIn} className="min-h-11 md:min-h-9">
            <LogIn className="size-4" aria-hidden />
            Sign in to {site}
          </Button>
        )}
        {(canContinue || step === 'saving') && (
          <Button
            // Inert while saving, but it stays put so the next step doesn't move the layout.
            aria-disabled={step === 'saving' || busy}
            onClick={() => {
              if (canContinue && !busy) onContinue();
            }}
            className="min-h-11 md:min-h-9"
          >
            <Play className="size-4" aria-hidden />
            Continue
          </Button>
        )}
        {canShowWindow && step === 'wall' && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={onShowWindow}
            className="min-h-11 md:min-h-9"
          >
            <Monitor className="size-4" aria-hidden />
            Show window
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onStop} className="min-h-11 md:min-h-9">
          Stop task
        </Button>
      </div>
    </section>
  );
}
