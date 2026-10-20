/**
 * The `/session` route's bar: the DM bar over a chat drawn as a direct message,
 * and the session bar over everything else (DOR-3074).
 *
 * @module widgets/one-bar/ui/SessionRouteHeader
 */
import { Terminal } from 'lucide-react';
import {
  useDirectMessageAgent,
  useDirectMessageView,
  useSessionViewLinks,
} from '@/layers/features/direct-message';
import { useOneBarState } from '../model/one-bar-context';
import { DirectMessageHeader } from './DirectMessageHeader';
import { SessionHeader } from './SessionHeader';

/**
 * Pick the bar for the chat on screen.
 *
 * With the DM view off, or on a chat that is not an agent's Direct chat, this
 * is {@link SessionHeader} exactly as it always was. On a Direct chat it is
 * {@link DirectMessageHeader}; on the session view behind one, the session bar
 * saying so, with the way back.
 */
export function SessionRouteHeader() {
  const { sessionId } = useOneBarState();
  const view = useDirectMessageView(sessionId ?? null);
  if (view.mode === 'dm' && view.chat && sessionId)
    return <DirectMessageHeader sessionId={sessionId} chat={view.chat} />;
  if (view.mode === 'session' && view.chat)
    return <SessionHeader behindDm={<BehindDirectMessage agentPath={view.chat.agentPath} />} />;
  return <SessionHeader />;
}

/**
 * `>_ Session · behind your DM with Scout`, where the second half goes back to
 * the DM.
 */
function BehindDirectMessage({ agentPath }: { agentPath: string }) {
  const { name } = useDirectMessageAgent(agentPath);
  const { openDirectMessage } = useSessionViewLinks();
  const label = `behind your DM with ${name ?? 'this agent'}`;
  return (
    <span
      className="text-muted-foreground flex min-w-[3rem] shrink-[9999] items-center gap-1.5 truncate"
      data-testid="session-behind-dm"
    >
      <Terminal className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">Session ·</span>
      <button
        type="button"
        onClick={openDirectMessage}
        className="focus-ring hover:text-foreground min-w-0 truncate rounded-sm underline-offset-4 hover:underline"
        title="Back to the DM"
      >
        {label}
      </button>
    </span>
  );
}
