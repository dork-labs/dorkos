/**
 * Sessions — every chat this agent has had, as the one chat list Switch
 * session draws too (spec `your-activity-first` D11).
 *
 * The one page with a search field (spec `profile-unification` §1.3): it is the
 * only list here that grows without limit, and the only one where you arrive
 * knowing roughly what you are looking for. The field lives in `ChatList`,
 * switched on here.
 *
 * @module features/profile/ui/pages/SessionsPage
 */
import { useCallback } from 'react';
import { toSession } from '@/layers/shared/lib';
import { useSafeNavigate } from '@/layers/shared/model';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useStartNewSession } from '@/layers/entities/session';
import { ChatList } from '@/layers/features/chat-list';
import type { ProfilePageContentProps } from './types';

/**
 * This agent's chats, with a way into each and a way to start a new one.
 *
 * Tapping a row **navigates**, it does not preview: the profile is a place you
 * look something up from, and a chat is somewhere you go. It carries the
 * directory as well as the session id, so the destination is this agent's chat
 * rather than whichever one the route was last on.
 */
export function SessionsPage({ member }: ProfilePageContentProps) {
  const projectPath = member.agent?.projectPath ?? null;
  const navigate = useSafeNavigate();
  const startNewSession = useStartNewSession();

  const open = useCallback(
    (sessionId: string) => {
      if (!navigate || projectPath === null) return;
      // The same record the header's Message button writes (DOR-1156): what ⌘K's
      // ranking and the New menu's "last used" read is the AGENT, not the chat.
      useInteractionStore.getState().recordOpened('agent', projectPath);
      void navigate(toSession({ dir: projectPath, session: sessionId }));
    },
    [navigate, projectPath]
  );

  const startNew = useCallback(() => {
    if (projectPath === null) return;
    useInteractionStore.getState().recordOpened('agent', projectPath);
    startNewSession(projectPath);
  }, [projectPath, startNewSession]);

  return (
    <ChatList
      agentPath={projectPath}
      agentName={member.displayName}
      onOpenChat={open}
      onNewChat={startNew}
      searchable
      className="flex-1"
    />
  );
}
