import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useSessionId } from './use-session-id';
import type { CreateSessionRequest } from '@dorkos/shared/types';

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
