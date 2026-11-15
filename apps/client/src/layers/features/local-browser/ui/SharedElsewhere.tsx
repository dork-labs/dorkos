import { useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentAgent } from '@/layers/entities/agent';
import { useSessionListStatus, useSessionRow } from '@/layers/entities/session';
import { toSession } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { useFirstFocus } from '../model/use-first-focus';

/** Props for {@link SharedElsewhere}. */
export interface SharedElsewhereProps {
  /** The chat the browser is shared with now. */
  holderSessionId: string;
  /** False in a room: only a direct chat can share the browser with an agent. */
  canTakeHere: boolean;
  /** Disables the take while another browser change runs. */
  disabled: boolean;
  /** Whether the panel is on screen; focus only moves to a visible button. */
  visible: boolean;
  /** Takes the browser for this chat; the other chat's agent loses it at once. */
  onTakeHere: () => void;
}

/**
 * The panel in one chat while another chat holds the Agent browser (DOR-4265). It
 * names that chat by its title, never its content, and takes it in one click.
 */
export function SharedElsewhere({
  holderSessionId,
  canTakeHere,
  disabled,
  visible,
  onTakeHere,
}: SharedElsewhereProps) {
  const navigate = useNavigate();
  const { data: holder } = useSessionRow(holderSessionId, { nameOnly: true });
  const { data: agent } = useCurrentAgent(holder?.cwd ?? null);
  // A chat has a live status only while its turn runs, so this is "working right now".
  const working = useSessionListStatus(holderSessionId) !== null;
  const agentName = agent?.displayName?.trim() || agent?.name;
  const title = holder?.title?.trim();
  const takeHere = useRef<HTMLButtonElement>(null);
  // Taking it is the one thing this view offers, so focus starts there.
  useFirstFocus(takeHere, visible && canTakeHere);
  const chat = title ? (
    <Button
      variant="link"
      // Inline with the sentence and wrapping in full: titles are capped at 60 characters.
      className="inline h-auto p-0 text-left text-sm leading-[inherit] break-words whitespace-normal md:h-auto"
      onClick={() => void navigate(toSession({ session: holderSessionId }))}
    >
      {title}
    </Button>
  ) : (
    'another chat'
  );
  return (
    <div data-slot="local-browser-shared-elsewhere" className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">This browser is open in another chat</p>
        <p className="text-muted-foreground text-sm">
          {working && agentName ? (
            <>
              <span>
                {agentName} is using it in {chat} right now.
              </span>{' '}
              <span>Taking it stops what {agentName} is doing there.</span>
            </>
          ) : working ? (
            <>Its agent is using it in {chat} right now. Taking it stops that.</>
          ) : title ? (
            <>{chat} has it. One chat uses a browser at a time.</>
          ) : (
            'Another chat has it. One chat uses a browser at a time.'
          )}
        </p>
      </div>
      {canTakeHere ? (
        <Button ref={takeHere} disabled={disabled} onClick={onTakeHere}>
          {working && agentName ? `Take it from ${agentName}` : 'Take it here'}
        </Button>
      ) : (
        <p className="text-muted-foreground text-xs">
          Open a direct chat with an agent to share it there.
        </p>
      )}
    </div>
  );
}
