import { useNavigate } from '@tanstack/react-router';
import { useSessionRow } from '@/layers/entities/session';
import { toSession } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

/** Props for {@link WaitingElsewhere}. */
export interface WaitingElsewhereProps {
  /** The chat whose agent is waiting on a person. */
  sessionId: string;
  /** The waiting agent's name, as the handoff card shows it. */
  agentName: string | null;
}

/**
 * A browser panel in any other chat while one chat's agent waits on a person. It names
 * that agent and chat, takes the person there, and answers nothing itself, so no other
 * chat can resume the agent or close its window.
 */
export function WaitingElsewhere({ sessionId, agentName }: WaitingElsewhereProps) {
  const navigate = useNavigate();
  const { data: chat } = useSessionRow(sessionId, { nameOnly: true });
  const title = chat?.title?.trim();
  const open = () => void navigate(toSession({ session: sessionId }));
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {agentName ? <strong className="font-medium">{agentName}</strong> : 'An agent'} in{' '}
        {title ? (
          <Button
            variant="link"
            // Inline with the sentence and wrapping in full, like the in-use view's title.
            className="inline h-auto p-0 text-left text-sm leading-[inherit] break-words whitespace-normal md:h-auto"
            onClick={open}
          >
            {title}
          </Button>
        ) : (
          'another chat'
        )}{' '}
        is waiting for you to finish signing in here.
      </p>
      <Button size="sm" variant="outline" onClick={open}>
        Open that chat
      </Button>
    </div>
  );
}
