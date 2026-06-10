/**
 * Recovery Path A — pull pending interactions on session mount and replay them
 * through the existing idempotent stream renderers.
 *
 * When a session is switched to, hard-refreshed, or opened while backgrounded, its
 * live `currentParts` were reset by `initSession()`, so any Approve/Deny card,
 * AskUserQuestion prompt, or MCP elicitation that the agent is still blocked on
 * disappears from the UI. This hook fetches the server-authoritative pending
 * interactions (`GET /api/sessions/:id/pending-interactions`) and feeds each one
 * back through the same `handleApprovalRequired` / `handleQuestionPrompt` /
 * `handleElicitationPrompt` handlers used by the live SSE stream — rebuilding the
 * card in place. Because those handlers upsert by interaction id, feeding the same
 * id from BOTH this pull and a live SSE re-emit (Path B) produces exactly one card.
 *
 * The DTO carries a server-authoritative `remainingMs`/`startedAt`, so the `#138`
 * countdown resumes at the true offset instead of resetting to the full timeout.
 *
 * @module features/chat/model/use-pending-interactions
 */
import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  MessagePart,
  HookPart,
  PendingInteractionDTO,
  SessionStatusEvent,
  TaskUpdateEvent,
} from '@dorkos/shared/types';
import { QUERY_TIMING } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { createStreamEventHandler } from './stream/stream-event-handler';
import type { ChatMessage } from './chat-types';

// ---------------------------------------------------------------------------
// DTO → native-event mapping
// ---------------------------------------------------------------------------

/**
 * Map a recovered {@link PendingInteractionDTO} to the `(eventType, data)` pair the
 * live stream renderers consume, so recovery reuses the exact same handlers rather
 * than a parallel renderer.
 *
 * `remainingMs` and `startedAt` are carried verbatim so the `#138` countdown seeds
 * from the server offset.
 */
function dtoToStreamEvent(dto: PendingInteractionDTO): { type: string; data: unknown } {
  switch (dto.type) {
    case 'approval':
      return {
        type: 'approval_required',
        data: {
          toolCallId: dto.id,
          toolName: dto.toolName,
          input: dto.input,
          startedAt: dto.startedAt,
          remainingMs: dto.remainingMs,
          hasSuggestions: dto.hasSuggestions,
          title: dto.title,
          displayName: dto.displayName,
          description: dto.description,
          blockedPath: dto.blockedPath,
          decisionReason: dto.decisionReason,
        },
      };
    case 'question':
      return {
        type: 'question_prompt',
        data: {
          toolCallId: dto.id,
          questions: dto.questions,
          startedAt: dto.startedAt,
          remainingMs: dto.remainingMs,
        },
      };
    case 'elicitation':
      return {
        type: 'elicitation_prompt',
        data: {
          interactionId: dto.id,
          serverName: dto.serverName,
          message: dto.message,
          mode: dto.mode,
          url: dto.url,
          elicitationId: dto.elicitationId,
          requestedSchema: dto.requestedSchema,
          startedAt: dto.startedAt,
          remainingMs: dto.remainingMs,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

interface UsePendingInteractionsParams {
  sessionId: string | null;
  transport: ReturnType<typeof useTransport>;
  selectedCwd: string | null;
  isStreaming: boolean;
  setMessages: (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Pull pending interactions on session mount (Path A) and hydrate their cards
 * through the live stream's idempotent renderers.
 *
 * Keyed on `sessionId` so it re-runs on every switch, cold navigation, and refresh
 * — the three DOR-73 mount cases. Disabled while a turn is actively streaming
 * (the live SSE stream already carries the prompt in-band) and when there is no
 * session.
 *
 * @returns The pending-interactions `query` plus `replayInteractionEvent` — the
 *   single routing entrypoint `syncEventHandlers` (Path B) reuses to feed a live
 *   re-emitted interaction event through the same idempotent handler instance.
 */
export function usePendingInteractions({
  sessionId,
  transport,
  selectedCwd,
  isStreaming,
  setMessages,
}: UsePendingInteractionsParams) {
  // Per-recovery scratch refs. Fresh and self-contained — recovery rebuilds the
  // card from server state after initSession() reset currentParts, so it never
  // shares the live stream's scratch buffers. All recovered DTOs in one resolution
  // route through ONE handler instance, so the upsert-by-id dedup folds the pull and
  // any same-id live re-emit into a single card.
  const currentPartsRef = useRef<MessagePart[]>([]);
  const orphanHooksRef = useRef<Map<string, HookPart[]>>(new Map());
  const assistantCreatedRef = useRef(false);
  const sessionStatusRef = useRef<SessionStatusEvent | null>(null);
  const streamStartTimeRef = useRef<number | null>(null);
  const estimatedTokensRef = useRef(0);
  const textStreamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTextStreamingRef = useRef(false);
  const thinkingStartRef = useRef<number | null>(null);
  const rateLimitClearRef = useRef<(() => void) | null>(null);
  const noopTaskRef = useRef<((event: TaskUpdateEvent) => void) | undefined>(undefined);
  const noopSessionIdRef = useRef<((newSessionId: string) => void) | undefined>(undefined);
  const noopDoneRef = useRef<(() => void) | undefined>(undefined);
  const noopThemeRef = useRef<(theme: 'light' | 'dark') => void>(() => {});
  const noopScrollRef = useRef<((messageId?: string) => void) | undefined>(undefined);
  const noopSwitchRef = useRef<((cwd: string) => void) | undefined>(undefined);

  // Stable assistant message id for this session's recovered card. Reusing one id
  // (rather than a per-event id) keeps every recovered interaction in a single
  // assistant bubble.
  const assistantId = useMemo(() => `recovered-interactions-${sessionId ?? 'none'}`, [sessionId]);

  // Reset scratch buffers whenever the session changes so a recovered card from a
  // previous session never bleeds into the next.
  useEffect(() => {
    currentPartsRef.current = [];
    assistantCreatedRef.current = false;
  }, [sessionId]);

  const { replayInteraction, replayInteractionEvent } = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs -- refs captured in closure; .current read only during replay
    const handler = createStreamEventHandler({
      currentPartsRef,
      orphanHooksRef,
      assistantCreatedRef,
      sessionStatusRef,
      streamStartTimeRef,
      estimatedTokensRef,
      textStreamingTimerRef,
      isTextStreamingRef,
      thinkingStartRef,
      setMessages,
      // Recovery only renders interaction cards — the remaining stream side effects
      // (status, errors, tokens, suggestions) are owned by the live stream, so they
      // are inert no-ops here.
      setError: () => {},
      setStatus: () => {},
      setSessionStatus: () => {},
      setEstimatedTokens: () => {},
      setStreamStartTime: () => {},
      setIsTextStreaming: () => {},
      setRateLimitRetryAfter: () => {},
      setIsRateLimited: () => {},
      setSystemStatus: () => {},
      setPromptSuggestions: () => {},
      rateLimitClearRef,
      sessionId: sessionId ?? '',
      onTaskEventRef: noopTaskRef,
      onSessionIdChangeRef: noopSessionIdRef,
      onStreamingDoneRef: noopDoneRef,
      themeRef: noopThemeRef,
      scrollToMessageRef: noopScrollRef,
      switchAgentRef: noopSwitchRef,
    });
    return {
      /** Replay a Path-A DTO by mapping it to its native stream event. */
      replayInteraction: (dto: PendingInteractionDTO) => {
        const { type, data } = dtoToStreamEvent(dto);
        handler(type, data, assistantId);
      },
      /**
       * Replay a raw native interaction event (Path B — re-emitted on the sync
       * stream) through the SAME handler instance, so a pull and a same-id live
       * re-emit upsert one card rather than stacking two. This is the single
       * routing entrypoint `syncEventHandlers` reuses for re-emitted
       * `approval_required` / `question_prompt` / `elicitation_prompt` events.
       */
      replayInteractionEvent: (type: string, data: unknown) => {
        handler(type, data, assistantId);
      },
    };
  }, [sessionId, assistantId, setMessages]);

  const query = useQuery({
    queryKey: ['pending-interactions', sessionId, selectedCwd],
    queryFn: () => transport.getPendingInteractions(sessionId!, selectedCwd ?? undefined),
    enabled: sessionId !== null && !isStreaming,
    staleTime: QUERY_TIMING.PENDING_INTERACTIONS_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });

  // Hydrate each recovered interaction through the idempotent renderer. The replay
  // is idempotent by interaction id, so re-running on a refetch (or alongside a live
  // SSE re-emit) never stacks duplicate cards.
  const { data } = query;
  useEffect(() => {
    if (!data) return;
    for (const interaction of data.interactions) {
      replayInteraction(interaction);
    }
  }, [data, replayInteraction]);

  return { query, replayInteractionEvent };
}
