import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCurrentAgent } from '@/layers/entities/agent';
import { sessionDisplayTitle, useSessionRow } from '@/layers/entities/session';
import { toSession } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

/** Props for {@link SharedElsewhere}. */
export interface SharedElsewhereProps {
  /** The chat the browser is shared with now. */
  holderSessionId: string;
  /** False in a room: only a direct chat can share the browser with an agent. */
  canMoveHere: boolean;
  /** Disables the move while another browser change runs. */
  disabled: boolean;
  /** Whether the panel is on screen; focus only moves to a visible button. */
  visible: boolean;
  /** Moves the browser to this chat; the other chat's agent loses it. */
  onUseHere: () => void;
}

/**
 * The panel in one chat while another chat holds the Agent browser (DOR-4265). It
 * names that chat by its title, never its content, and offers one click to move it.
 */
export function SharedElsewhere({
  holderSessionId,
  canMoveHere,
  disabled,
  visible,
  onUseHere,
}: SharedElsewhereProps) {
  const navigate = useNavigate();
  const { data: holder } = useSessionRow(holderSessionId, { nameOnly: true });
  const { data: agent } = useCurrentAgent(holder?.cwd ?? null);
  const agentName = agent?.displayName?.trim() || agent?.name;
  const title = sessionDisplayTitle(holder?.title);
  const useHere = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The move is the one thing this view offers, so focus starts there.
    if (visible) useHere.current?.focus();
  }, [visible]);
  const link = (
    <Button
      variant="link"
      title={title}
      className="inline-block h-auto max-w-[16rem] truncate p-0 align-bottom text-sm"
      onClick={() => void navigate(toSession({ session: holderSessionId }))}
    >
      {title}
    </Button>
  );
  return (
    <div data-slot="local-browser-shared-elsewhere" className="space-y-3">
      <p className="text-sm">
        {agentName ? (
          <>
            {agentName} is using it in {link}.
          </>
        ) : (
          <>It’s open in {link}.</>
        )}
      </p>
      {canMoveHere ? (
        <div className="space-y-1">
          <Button ref={useHere} disabled={disabled} onClick={onUseHere}>
            Use it here
          </Button>
          <p className="text-muted-foreground truncate text-xs" title={title}>
            {title} loses it until you move it back.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Open a direct chat with an agent to share it there.
        </p>
      )}
    </div>
  );
}
