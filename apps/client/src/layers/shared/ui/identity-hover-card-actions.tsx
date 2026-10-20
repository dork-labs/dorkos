/**
 * What an identity card says about an agent beyond its name, and what it
 * offers to do (DOR-3074): its role, what it is doing, and Message, Profile
 * and the session it is working in here.
 *
 * @module shared/ui/identity-hover-card-actions
 */
import { SquareTerminal } from 'lucide-react';
import { Button } from './button';

/** The card's role and status lines. */
export interface IdentityHoverCardAbout {
  /** What the identity does, drawn after its kind: `Agent · Reviews pull requests`. */
  role?: string | null;
  /** What it is doing: `Working in #launch`, `Idle · last active 4m ago`. */
  status?: string | null;
}

/** What the card offers to do. Each is drawn only when it is handed. */
export interface IdentityHoverCardActions {
  /** Open the direct message with this identity. The primary action. */
  onMessage?: () => void;
  /** Open this identity's profile. */
  onViewProfile?: () => void;
  /** Open the working session this identity has here, with what to call it. */
  session?: { label: string; onOpen: () => void };
}

/**
 * The kind line and the status line, under the name.
 *
 * @param props.kind - What the identity is; an agent's line starts "Agent".
 * @param props.about - The role and status to draw.
 */
export function IdentityHoverCardAboutLines({
  kind,
  about,
}: {
  kind: 'human' | 'agent' | 'system';
  about: IdentityHoverCardAbout;
}) {
  const kindWord = kind === 'agent' ? 'Agent' : kind === 'human' ? 'Person' : null;
  const kindLine = [kindWord, about.role].filter(Boolean).join(' · ');
  if (!kindLine && !about.status) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 pb-3" data-slot="identity-hover-card-about">
      {kindLine && (
        <p className="text-muted-foreground truncate text-xs" title={kindLine}>
          {kindLine}
        </p>
      )}
      {about.status && (
        <p className="text-foreground/80 truncate text-xs" data-slot="identity-hover-card-status">
          {about.status}
        </p>
      )}
    </div>
  );
}

/**
 * The action row: Message first and filled, Profile beside it, and the
 * session as a quiet line under both.
 *
 * Like the card's own footer, this is the POINTER path. A keyboard reaches the
 * same places through the trigger's own click (a name or a mention opens the
 * profile) and the message's action capsule.
 *
 * @param props.actions - What to offer.
 * @param props.onAct - Called before any action runs: hands focus back to the
 *   trigger and closes the card, so what opens next lands on solid ground.
 */
export function IdentityHoverCardActionRow({
  actions,
  onAct,
}: {
  actions: IdentityHoverCardActions;
  onAct: () => void;
}) {
  const run = (action: () => void) => () => {
    onAct();
    action();
  };
  return (
    <div
      className="border-border mt-auto flex flex-col gap-2 border-t p-3"
      data-slot="identity-hover-card-actions"
    >
      <div className="flex gap-2">
        {actions.onMessage && (
          <Button size="xs" className="flex-1" onClick={run(actions.onMessage)}>
            Message
          </Button>
        )}
        {actions.onViewProfile && (
          <Button
            size="xs"
            variant="outline"
            className="flex-1"
            onClick={run(actions.onViewProfile)}
          >
            Profile
          </Button>
        )}
      </div>
      {actions.session && (
        <button
          type="button"
          data-slot="identity-hover-card-session"
          onClick={run(actions.session.onOpen)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-w-0 items-center gap-1.5 rounded-sm text-left text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{actions.session.label}</span>
        </button>
      )}
    </div>
  );
}
