/**
 * The Work tab: the turn-by-turn view of the session behind a DM (DOR-3075).
 *
 * @module widgets/session/ui/work/WorkPanel
 */
import { useCallback, useEffect, useState } from 'react';
import { toSession } from '@/layers/shared/lib';
import { useAppStore, useSafeNavigate } from '@/layers/shared/model';
import { useSessionChatStatus, useSessionMessages } from '@/layers/entities/session';
import { useRoomBoundSession } from '@/layers/entities/room';
import {
  useDirectMessageAgent,
  useDirectMessagePanel,
  useSessionViewLinks,
  type GroupDmMember,
} from '@/layers/features/direct-message';
import { useSessionReadout } from '@/layers/features/chat';
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
  const messages = useSessionMessages(sessionId);
  const working = useSessionChatStatus(sessionId) === 'streaming';
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
 * Which session that is moves after every turn, so it is asked again each
 * time the member changes. While anyone in the DM is working, the steps are
 * read again every few seconds.
 */
function GroupWork({
  members,
  working,
  showSessions,
}: {
  members: readonly GroupDmMember[];
  working: boolean;
  showSessions: boolean;
}) {
  const picked = useAppStore((s) => s.explicitAgentPath);
  const member = members.find((candidate) => candidate.agentPath === picked) ?? null;
  const resolve = useRoomBoundSession();
  // The answer for one member: their session here, or `null` for none yet.
  const [found, setFound] = useState<{ agentPath: string; sessionId: string | null } | null>(null);
  const memberPath = member?.agentPath ?? null;

  useEffect(() => {
    if (memberPath === null) return;
    let current = true;
    void resolve(memberPath).then((sessionId) => {
      if (current) setFound({ agentPath: memberPath, sessionId });
    });
    return () => {
      current = false;
    };
  }, [memberPath, resolve]);

  const sessionId = found !== null && found.agentPath === memberPath ? found.sessionId : null;
  const asking = memberPath !== null && (found === null || found.agentPath !== memberPath);
  const readout = useSessionReadout(sessionId, working);
  const navigate = useSafeNavigate();
  const openSession = useCallback(() => {
    if (sessionId !== null && navigate) void navigate(toSession({ session: sessionId }));
  }, [navigate, sessionId]);

  let notice: string | null = null;
  if (member === null) notice = 'Pick a member above.';
  else if (asking || readout.isLoading) notice = 'Loading steps…';
  else if (sessionId === null) notice = `${member.displayName} hasn’t worked in this DM yet.`;
  else if (readout.isError) notice = 'Couldn’t load these steps.';

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
