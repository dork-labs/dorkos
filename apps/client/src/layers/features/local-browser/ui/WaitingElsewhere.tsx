import { useNavigate } from '@tanstack/react-router';
import { toSession } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

/** Props for {@link WaitingElsewhere}. */
export interface WaitingElsewhereProps {
  /** The chat whose agent is waiting on a person. */
  sessionId: string;
}

/**
 * A browser panel in any other chat while one chat's agent waits on a person. It takes
 * the person to that chat and answers nothing itself, so no other chat can resume the
 * agent or close its window.
 */
export function WaitingElsewhere({ sessionId }: WaitingElsewhereProps) {
  const navigate = useNavigate();
  return (
    <div className="space-y-3">
      <p className="text-sm">Another agent is waiting for a person in this window.</p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void navigate(toSession({ session: sessionId }))}
      >
        Open that chat
      </Button>
    </div>
  );
}
