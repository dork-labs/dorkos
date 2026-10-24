/**
 * The Work tab: the turn-by-turn view of the session behind a DM (DOR-3075).
 *
 * @module widgets/session/ui/work/WorkPanel
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toSession } from '@/layers/shared/lib';
import { useAppStore, useSafeNavigate } from '@/layers/shared/model';
import {
  useSessionChatState,
  useSessionRenderedStatus,
  useSessionStreamState,
} from '@/layers/entities/session';
import { useRoomSessions } from '@/layers/entities/room';
import {
  useDirectMessageAgent,
  useDirectMessagePanel,
  useSessionViewLinks,
  type GroupDmMember,
} from '@/layers/features/direct-message';
import { selectRenderedMessages, useSessionReadout } from '@/layers/features/chat';
import { WorkView } from './WorkView';

/**
 * Draw the work of the session behind the DM beside the panel.
 *
 * In a chat with one agent that is the chat's own session, live as it runs:
 * the same messages the transcript is drawn from. In a group DM it is the
 * session the picked member works in there, read without opening it.
 */
export function WorkPanel() {
  const panel = useDirectMessagePanel();
  if (panel?.kind === 'one-to-one') {
    return (
      <DirectWork
        sessionId={panel.sessionId}
        agentPath={panel.agentPath}
        showSessions={panel.showSessions}
      />
    );
  }
  if (panel?.kind === 'group') {
    return (
      <GroupWork
        roomId={panel.roomId}
        members={panel.members}
        working={panel.working}
        showSessions={panel.showSessions}
      />
    );
  }
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-xs">
      Open a DM to see its work.
    </div>
  );
}

/** A chat with one agent: its own session, from the chat's live store. */
function DirectWork({
  sessionId,
  agentPath,
  showSessions,
}: {
  sessionId: string;
  agentPath: string;
  showSessions: boolean;
}) {
  // The very list the chat itself draws: the live stream once it has caught
  // up, the history read before that. So a turn running now is here as it runs.
  const streamState = useSessionStreamState(sessionId);
  const { messages: legacyMessages } = useSessionChatState(sessionId);
  const messages = useMemo(
    () => selectRenderedMessages(streamState, legacyMessages),
    [streamState, legacyMessages]
  );
  const working = useSessionRenderedStatus(sessionId) === 'streaming';
  const { name } = useDirectMessageAgent(agentPath);
  const { openSessionView } = useSessionViewLinks();
  return (
    <WorkView
      sessionId={sessionId}
      messages={messages}
      agentName={name}
      showSessions={showSessions}
      onOpenSession={openSessionView}
      working={working}
    />
  );
}

/**
 * A group DM: the session the picked member works in there.
 *
 * Which session that is moves after every turn, so the room's bindings are
 * read again each time a turn starts or ends, and the steps are read again
 * every few seconds while anyone in the DM is working.
 */
function GroupWork({
  roomId,
  members,
  working,
  showSessions,
}: {
  roomId: string;
  members: readonly GroupDmMember[];
  working: boolean;
  showSessions: boolean;
}) {
  const picked = useAppStore((s) => s.explicitAgentPath);
  const member = members.find((candidate) => candidate.agentPath === picked) ?? null;
  const bindings = useRoomSessions(roomId, { enabled: member !== null });
  const { refetch } = bindings;
  // A turn starting or ending is when a binding can move.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current === working) return;
    wasWorking.current = working;
    void refetch();
  }, [working, refetch]);

  const sessionId =
    member === null
      ? null
      : (bindings.data?.bindings.find((binding) => binding.authorId === member.authorId)
          ?.sessionId ?? null);
  const readout = useSessionReadout(sessionId, working);
  const navigate = useSafeNavigate();
  const openSession = useCallback(() => {
    if (sessionId !== null && navigate) void navigate(toSession({ session: sessionId }));
  }, [navigate, sessionId]);

  let notice: string | null = null;
  if (member === null) notice = 'Pick a member above.';
  else if (bindings.isError || readout.isError) notice = 'Couldn’t load these steps.';
  else if (bindings.isPending || readout.isLoading) notice = 'Loading steps…';
  else if (sessionId === null) notice = `${member.displayName} hasn’t worked in this DM yet.`;

  return (
    <WorkView
      sessionId={sessionId}
      messages={readout.messages}
      agentName={member?.displayName ?? null}
      showSessions={showSessions}
      onOpenSession={openSession}
      notice={notice}
    />
  );
}
