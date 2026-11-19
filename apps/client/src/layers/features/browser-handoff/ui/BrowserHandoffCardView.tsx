import { Check, Hand, KeyRound, LogIn, Monitor, Play } from 'lucide-react';
import { DONE_SIGNING_IN, SIGN_IN_SAVING, signInOpenLine } from '@/layers/entities/local-browser';
import { shortenHomePath } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { cardAgentName } from '../lib/agent-name';
import type { HandoffStep } from '../lib/handoff-step';
import { YourTurnStrip } from './YourTurnStrip';

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
  /** The sign-in lands in the default profile, which every agent shares. */
  sharedProfile?: boolean;
  /** A button's call is running. */
  busy: boolean;
  error: string | null;
  onContinue: () => void;
  /** Quit the sign-in window and save it, for when its close can't be seen. */
  onDone: () => void;
  onSignIn: () => void;
  onOpenWindow: () => void;
  onShowWindow: () => void;
  onStop: () => void;
}

/** The status line for each step of the plain sign-in window, in the words the panel uses too. */
function signInStatus(step: HandoffStep, site: string): string | null {
  if (step === 'sign-in-open') return signInOpenLine(site);
  if (step === 'saving') return SIGN_IN_SAVING;
  if (step === 'saved') return `Signed in to ${site}.`;
  if (step === 'failed') return 'Couldn’t save your sign-in.';
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
  sharedProfile = false,
  busy,
  error,
  onContinue,
  onDone,
  onSignIn,
  onOpenWindow,
  onShowWindow,
  onStop,
}: BrowserHandoffCardViewProps) {
  const name = cardAgentName(agentName);
  const asksPassword = step === 'sign-in' || step === 'failed';
  const status = signInStatus(step, site);
  const canContinue = step === 'person' || step === 'wall' || step === 'saved';
  // The host goes in the wrapping title, never in a button, so a long one can't push a
  // control out of the card on a phone.
  const title = asksPassword
    ? `${site} needs you to sign in`
    : `${site} wants a person to continue`;
  const showWindowFirst = canShowWindow && step === 'wall';
  return (
    <section
      aria-label={title}
      data-slot="browser-handoff-card"
      className="bg-card mb-2 flex flex-col gap-3 rounded-xl border p-3 text-sm"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
          <Hand className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="font-medium break-words">{title}</h3>
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
      {step === 'person' && (
        <div className="space-y-1">
          <p>Finish in {name}’s window, then press Continue.</p>
          <p className="text-muted-foreground">
            {name} can’t see or use it until you hand it back.
          </p>
        </div>
      )}
      {step === 'wall' && (
        <div className="space-y-2">
          <YourTurnStrip agentName={agentName} />
          <p>The site wants a check only a person can do. It isn’t anything you did.</p>
        </div>
      )}
      {/* The agent chooses the reason, so a page it called a check could still ask for a
          password. The card can't know, so every check says where a password goes. */}
      {step === 'wall' && (
        <div className="bg-muted/50 flex gap-2 rounded-md p-2">
          <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
          {/* Inside the text column, so a wrapped button lines up with the sentence. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 basis-48">
              If it asks for a password, don’t type it in {name}’s window.
            </p>
            {/* The one sign-in path on a wall: a quiet link, so it never competes with Continue. */}
            <Button
              variant="link"
              size="sm"
              disabled={busy}
              onClick={onSignIn}
              className="min-h-11 px-0 md:min-h-8"
            >
              Sign in instead
            </Button>
          </div>
        </div>
      )}
      {asksPassword && (
        <div className="space-y-1">
          <p>Open a sign-in window. {name} can’t see or use it.</p>
          {step === 'sign-in' && sharedProfile && (
            <p className="text-muted-foreground">
              Every agent that uses the Agent browser can use this sign-in.
            </p>
          )}
        </div>
      )}
      {step === 'window-closed' && (
        <p>The window closed. Open it again to finish, or stop the task.</p>
      )}
      {status && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
      {step === 'sign-in-open' && sharedProfile && (
        <p className="text-muted-foreground">
          Every agent that uses the Agent browser can use this sign-in.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {step === 'window-closed' && (
          <Button disabled={busy} onClick={onOpenWindow} className="min-h-11 md:min-h-9">
            <Monitor className="size-4" aria-hidden />
            Open window
          </Button>
        )}
        {asksPassword && (
          <Button disabled={busy} onClick={onSignIn} className="min-h-11 md:min-h-9">
            <LogIn className="size-4" aria-hidden />
            {step === 'failed' ? 'Sign in again' : 'Open sign-in window'}
          </Button>
        )}
        {(step === 'sign-in-open' || step === 'saving') && (
          <Button
            // Inert while saving, and shown as such, but it stays put so the layout holds.
            disabled={step === 'saving' || busy}
            aria-disabled={step === 'saving' || busy}
            onClick={onDone}
            className="min-h-11 md:min-h-9"
          >
            <Check className="size-4" aria-hidden />
            {DONE_SIGNING_IN}
          </Button>
        )}
        {/* Show window leads on a wall: it's the next thing to do. */}
        {showWindowFirst && (
          <Button disabled={busy} onClick={onShowWindow} className="min-h-11 md:min-h-9">
            <Monitor className="size-4" aria-hidden />
            Show window
          </Button>
        )}
        {canContinue && (
          <Button
            variant={showWindowFirst ? 'secondary' : 'default'}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onContinue();
            }}
            className="min-h-11 md:min-h-9"
          >
            <Play className="size-4" aria-hidden />
            Continue
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onStop} className="min-h-11 md:min-h-9">
          Stop task
        </Button>
      </div>
    </section>
  );
}
