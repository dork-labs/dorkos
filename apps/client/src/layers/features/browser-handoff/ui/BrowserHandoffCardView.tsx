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
  /** Signing in closes the Mac app's panel, which would look like a crash unless said. */
  movesToOwnWindow?: boolean;
  /** The sign-in lands in the default profile, which every agent shares. */
  sharedProfile?: boolean;
  /** A button's call is running. */
  busy: boolean;
  error: string | null;
  onContinue: () => void;
  onSignIn: () => void;
  onOpenWindow: () => void;
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
  movesToOwnWindow = false,
  sharedProfile = false,
  busy,
  error,
  onContinue,
  onSignIn,
  onOpenWindow,
  onShowWindow,
  onStop,
}: BrowserHandoffCardViewProps) {
  // An agent picks its own name, and control or direction characters could reorder the sentence.
  const whole = agentName?.replace(/[\p{Cc}\p{Cf}]/gu, '') || 'The agent';
  const name = whole.length > MAX_AGENT_NAME ? `${whole.slice(0, MAX_AGENT_NAME)}…` : whole;
  const asksPassword = step === 'sign-in' || step === 'failed';
  const status = signInStatus(step, site);
  const canContinue = step === 'wall' || step === 'saved';
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
      {step === 'wall' && (
        <div className="space-y-1">
          {/* True because the server refuses every browser tool for that chat until hand-back. */}
          <p className="font-medium">Your turn: {name} can’t see or use this window.</p>
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
            {movesToOwnWindow && (
              <p className="text-muted-foreground basis-full">
                {name} moves to its own window after you sign in.
              </p>
            )}
          </div>
        </div>
      )}
      {asksPassword && (
        <div className="space-y-1">
          <p>Open a sign-in window. {name} can’t see or use it.</p>
          {step === 'sign-in' && movesToOwnWindow && (
            <p className="text-muted-foreground">
              {name} moves to its own window after you sign in.
            </p>
          )}
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
            Open sign-in window
          </Button>
        )}
        {/* Show window leads on a wall: it's the next thing to do. */}
        {showWindowFirst && (
          <Button disabled={busy} onClick={onShowWindow} className="min-h-11 md:min-h-9">
            <Monitor className="size-4" aria-hidden />
            Show window
          </Button>
        )}
        {(canContinue || step === 'saving') && (
          <Button
            variant={showWindowFirst ? 'secondary' : 'default'}
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
        <Button variant="ghost" disabled={busy} onClick={onStop} className="min-h-11 md:min-h-9">
          Stop task
        </Button>
      </div>
    </section>
  );
}
