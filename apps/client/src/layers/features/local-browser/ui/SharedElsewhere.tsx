import { useNavigate } from '@tanstack/react-router';
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
  /** Moves the browser to this chat; the other chat's agent loses it. */
  onMoveHere: () => void;
}

/**
 * The panel in one chat while another chat holds the Agent browser (DOR-4265). It
 * names that chat by its title, never its content, and offers one click to move it.
 */
export function SharedElsewhere({
  holderSessionId,
  canMoveHere,
  disabled,
  onMoveHere,
}: SharedElsewhereProps) {
  const navigate = useNavigate();
  const { data: holder } = useSessionRow(holderSessionId, { nameOnly: true });
  return (
    <div data-slot="local-browser-shared-elsewhere" className="space-y-3">
      <p className="text-sm">
        In use in{' '}
        <Button
          variant="link"
          className="h-auto p-0 align-baseline text-sm"
          onClick={() => void navigate(toSession({ session: holderSessionId }))}
        >
          {sessionDisplayTitle(holder?.title)}
        </Button>
      </p>
      {canMoveHere ? (
        <>
          <Button disabled={disabled} onClick={onMoveHere}>
            Move browser here
          </Button>
          <p className="text-muted-foreground text-xs">That chat’s agent loses the browser.</p>
        </>
      ) : (
        <p className="text-muted-foreground text-xs">
          Open a direct chat with an agent to share it there.
        </p>
      )}
    </div>
  );
}
