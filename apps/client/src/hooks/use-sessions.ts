import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '../contexts/TransportContext';
import { useSessionId } from './use-session-id';
import { useAppStore } from '../stores/app-store';
import type { CreateSessionRequest } from '@lifeos/shared/types';

export function useSessions() {
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSession] = useSessionId();
  const transport = useTransport();
  const { selectedCwd } = useAppStore();

  const sessionsQuery = useQuery({
    queryKey: ['sessions', selectedCwd],
    queryFn: () => transport.listSessions(selectedCwd ?? undefined),
    refetchInterval: 60_000,
    enabled: selectedCwd !== null,
  });

  const createSession = useMutation({
    mutationFn: (opts: CreateSessionRequest) =>
      transport.createSession({ ...opts, cwd: selectedCwd ?? undefined }),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', selectedCwd] });
      setActiveSession(session.id);
    },
  });

  return {
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    createSession,
    activeSessionId,
    setActiveSession,
  };
}
