/**
 * Sessions — every conversation this agent has had, newest first (spec
 * `profile-unification` §1.5).
 *
 * The one page with a search field (§1.3): it is the only list here that grows
 * without limit, and the only one where you arrive knowing roughly what you are
 * looking for.
 *
 * @module features/profile/ui/pages/SessionsPage
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import { groupSessionsByTime } from '@/layers/shared/lib';
import { Input, Skeleton } from '@/layers/shared/ui';
import { useSafeNavigate, useTransport } from '@/layers/shared/model';
import { useInteractionStore } from '@/layers/entities/interactions';
import { sessionKeys, useAgentSessions, useRenameSession } from '@/layers/entities/session';
import { SessionsView } from '@/layers/features/session-list';
import type { ProfilePageContentProps } from './types';

/** Does this session answer what was typed? Title only — the transcript is not loaded here. */
function matches(session: Session, query: string): boolean {
  if (query === '') return true;
  return (session.title ?? '').toLowerCase().includes(query);
}

/**
 * This agent's conversations, grouped by day, with a way into each.
 *
 * Tapping a row **navigates**, it does not preview: the profile is a place you
 * look something up from, and a conversation is somewhere you go. It carries the
 * directory as well as the session id, so the destination is this agent's
 * session rather than whichever one the route was last on.
 */
export function SessionsPage({ member }: ProfilePageContentProps) {
  const projectPath = member.agent?.projectPath ?? null;
  const { sessions, isLoading, isError, activeSessionId } = useAgentSessions(projectPath);
  const navigate = useSafeNavigate();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const renameSession = useRenameSession(projectPath);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const grouped = useMemo(
    () => groupSessionsByTime(sessions.filter((session) => matches(session, needle))),
    [sessions, needle]
  );

  function open(sessionId: string) {
    if (!navigate || projectPath === null) return;
    // The same record the header's Message button writes (DOR-1156): what ⌘K's
    // ranking and the New menu's "last used" read is the AGENT, not the session.
    useInteractionStore.getState().recordOpened('agent', projectPath);
    void navigate({ to: '/session', search: { dir: projectPath, session: sessionId } });
  }

  async function fork(sessionId: string) {
    try {
      const forked = await transport.forkSession(sessionId, undefined, projectPath ?? undefined);
      await queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });
      open(forked.id);
    } catch (err) {
      toast.error("Couldn't branch off this conversation.", {
        description: err instanceof Error ? err.message : 'The original is untouched.',
      });
    }
  }

  // Three ways to have no rows, and only one of them is "there are none". The
  // page used to answer all three with "No conversations yet", so an agent with
  // a hundred conversations was announced as having never spoken while its list
  // was still in flight (DOR-1253). Same shapes the Rooms page uses.
  if (isLoading) return <Skeleton className="h-16 w-full" />;

  if (isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Couldn’t read {member.displayName}’s conversations.
      </p>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No conversations yet. {member.displayName} starts one the first time you message it.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="relative shrink-0">
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="h-8 pl-7 text-sm"
        />
      </div>

      {grouped.length === 0 ? (
        <p className="text-muted-foreground text-sm">No conversation matches “{query.trim()}”.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <SessionsView
            activeSessionId={activeSessionId}
            groupedSessions={grouped}
            onSessionClick={open}
            onForkSession={(id) => void fork(id)}
            onRenameSession={(id, title) => renameSession.mutate({ sessionId: id, title })}
          />
        </div>
      )}
    </div>
  );
}
