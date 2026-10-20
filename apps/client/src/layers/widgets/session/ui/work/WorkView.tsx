/**
 * A session's work, turn by turn: the body of the Work tab (DOR-3075).
 *
 * @module widgets/session/ui/work/WorkView
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { ArrowUpRight, Terminal } from 'lucide-react';
import type { ChatMessage } from '@/layers/shared/model';
import { activityVerb, useLatest } from '@/layers/shared/lib';
import { useModels, useSessionToolActivity } from '@/layers/entities/session';
import { formatTime } from '@/layers/features/conversation';
import { statusModelLabel, useSessionDiagnostics } from '@/layers/features/status';
import { AssistantMessageContent, MessageProvider } from '@/layers/features/chat';
import { buildWorkTurns, type WorkTurn } from '../../lib/work-turns';
import { useWorkPanelFocusStore } from '../../model/work-panel-focus';

/** How near the end still counts as at the end, in pixels. */
const FOLLOW_SLACK_PX = 48;

/** The heading of the turn running now: it may answer a task or another chat. */
const LIVE_HEADING = 'Now · working';

/** Everything the Work tab draws for one session. */
export interface WorkViewProps {
  /** The session whose work this is, or `null` when there is none to show. */
  sessionId: string | null;
  /** Its transcript, oldest first. */
  messages: readonly ChatMessage[];
  /** The agent's name, for the line at the top. */
  agentName: string | null;
  /** Whether Show sessions is on: the top line names the session then. */
  showSessions: boolean;
  /** Open the session itself (Show sessions only). */
  onOpenSession: () => void;
  /** Whether a turn is running now, before it has done any work. */
  working?: boolean;
  /** What to say instead of the turns, when there is something to say. */
  notice?: string | null;
}

/**
 * Draw every step the agent took, one turn after another, the running turn
 * included.
 *
 * Each step is the session's own card (the same tool card and thinking block
 * the session view draws), with nothing hidden. A press of Show work or Watch
 * scrolls to its turn; otherwise the newest turn is in view.
 *
 * @param props - See {@link WorkViewProps}.
 */
export function WorkView({
  sessionId,
  messages,
  agentName,
  showSessions,
  onOpenSession,
  working = false,
  notice = null,
}: WorkViewProps) {
  const turns = useMemo(() => buildWorkTurns(messages), [messages]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const request = useWorkPanelFocusStore((s) => s.request);
  const consume = useWorkPanelFocusStore((s) => s.consume);
  const hasLive = turns.some((turn) => turn.live);
  const latestTurns = useLatest(turns);
  // Whether the view follows the newest step: true until the person scrolls
  // up, and again once they scroll back to the end.
  const following = useRef(true);
  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    following.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_SLACK_PX;
  }, []);

  // Each step that lands keeps a following reader at the end, and leaves one
  // who has scrolled up exactly where they are, including when the running
  // turn's stand-in id is swapped for the saved one.
  // Another chat opens at its newest step, however far up the last one was read.
  const shownSession = useRef(sessionId);
  useLayoutEffect(() => {
    if (shownSession.current !== sessionId) {
      shownSession.current = sessionId;
      following.current = true;
    }
    const scroller = scrollerRef.current;
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  });

  // A Show work or Watch press: scroll to its turn and put focus there, so a
  // keyboard or screen-reader user lands on what they asked for. Acted on once
  // per request; a request for another session is let go.
  const shape = `${turns.length}|${hasLive}`;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !request) return;
    if (request.sessionId !== sessionId) {
      consume();
      return;
    }
    const current = latestTurns.read();
    const target =
      request.turn === 'live'
        ? (current.find((turn) => turn.live)?.key ?? 'live')
        : current.find((turn) => turn.replies.some((reply) => reply.id === request.turn))?.key;
    const node = Array.from(scroller.querySelectorAll<HTMLElement>('[data-work-turn]')).find(
      (candidate) => candidate.dataset.workTurn === target
    );
    // Nothing read yet: wait for the turns rather than spend the request.
    if (!node && current.length === 0 && request.turn !== 'live') return;
    if (node) {
      node.scrollIntoView?.({ block: 'start' });
      node.focus({ preventScroll: true });
    }
    following.current = request.turn === 'live' || !node;
    if (following.current) scroller.scrollTop = scroller.scrollHeight;
    consume();
  }, [request, sessionId, shape, latestTurns, consume]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      data-testid="work-panel"
      className="flex h-full min-w-0 flex-col gap-3 overflow-y-auto p-3"
    >
      <WorkTopLine
        sessionId={sessionId}
        agentName={agentName}
        showSessions={showSessions}
        onOpenSession={onOpenSession}
      />
      {notice !== null ? (
        <Quiet>{notice}</Quiet>
      ) : (
        <>
          {turns.length === 0 && !working && <Quiet>No steps yet.</Quiet>}
          {turns.map((turn) => (
            <WorkTurnCard key={turn.key} turn={turn} sessionId={sessionId!} />
          ))}
          {working && !hasLive && sessionId !== null && <StartingTurn sessionId={sessionId} />}
        </>
      )}
    </div>
  );
}

/**
 * `Session · Opus 5.5 · 64% context · Open session ↗` with Show sessions on,
 * and for everyone else the one line saying what this tab is.
 */
function WorkTopLine({
  sessionId,
  agentName,
  showSessions,
  onOpenSession,
}: Pick<WorkViewProps, 'sessionId' | 'agentName' | 'showSessions' | 'onOpenSession'>) {
  if (!showSessions || sessionId === null) {
    return (
      <div className="bg-muted/50 text-muted-foreground rounded-md px-3 py-2 text-xs">
        Every step {agentName ?? 'the agent'} took, turn by turn.
      </div>
    );
  }
  return <SessionLine sessionId={sessionId} onOpenSession={onOpenSession} />;
}

/** The session line, which reads the session's own model and context. */
function SessionLine({
  sessionId,
  onOpenSession,
}: {
  sessionId: string;
  onOpenSession: () => void;
}) {
  const { model, contextPercent, runtime } = useSessionDiagnostics(sessionId);
  // The same catalog read the session's own model picker makes, so a cache hit.
  const { data: models } = useModels({ sessionId, runtime: runtime ?? undefined });
  const words = ['Session'];
  if (model) words.push(statusModelLabel(model, models ?? []));
  if (typeof contextPercent === 'number') words.push(`${Math.round(contextPercent)}% context`);
  return (
    <div
      data-testid="work-session-line"
      className="bg-muted/50 text-muted-foreground flex items-center gap-2 rounded-md px-3 py-2 text-xs"
    >
      <Terminal className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono">{words.join(' · ')}</span>
      <button
        type="button"
        onClick={onOpenSession}
        className="focus-ring hover:text-foreground inline-flex shrink-0 items-center gap-0.5 rounded-sm font-medium transition-colors"
      >
        Open session
        <ArrowUpRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/** One turn: what opened it, then each step, the session's own cards. */
function WorkTurnCard({ turn, sessionId }: { turn: WorkTurn; sessionId: string }) {
  const time = turn.startedAt ? formatTime(turn.startedAt) : '';
  const heading = turn.live
    ? LIVE_HEADING
    : [time, turn.prompt ? `“${turn.prompt}”` : ''].filter(Boolean).join(' · ') || 'A turn';
  return (
    <section
      data-work-turn={turn.key}
      data-live={turn.live || undefined}
      aria-label={heading}
      tabIndex={-1}
      className="focus-ring rounded-lg border px-3 py-2"
    >
      <h3 className="text-foreground line-clamp-2 text-xs font-medium">{heading}</h3>
      {turn.replies.map((reply) => (
        <WorkReply key={reply.id} reply={reply} sessionId={sessionId} />
      ))}
    </section>
  );
}

/**
 * One reply's steps. Memoized on the reply itself: a finished reply keeps its
 * object while the running one streams, so past turns are not drawn again on
 * every update.
 */
const WorkReply = memo(function WorkReply({
  reply,
  sessionId,
}: {
  reply: ChatMessage;
  sessionId: string;
}) {
  const isStreaming = reply._streaming === true;
  const context = useMemo(
    () => ({
      sessionId,
      isStreaming,
      isLatestWidgetMessage: true,
      isFinalMessage: false,
      activeToolCallId: null,
      onToolRef: undefined,
      focusedOptionIndex: -1,
      onToolDecided: undefined,
      inputZoneToolCallId: null,
    }),
    [sessionId, isStreaming]
  );
  return (
    <MessageProvider value={context}>
      <AssistantMessageContent message={reply} show="work" />
    </MessageProvider>
  );
});

/** A turn that has started and not done anything yet: what the agent is doing. */
function StartingTurn({ sessionId }: { sessionId: string }) {
  const activity = useSessionToolActivity(sessionId);
  return (
    <section
      data-work-turn="live"
      data-live
      aria-label={LIVE_HEADING}
      tabIndex={-1}
      className="focus-ring rounded-lg border px-3 py-2"
    >
      <h3 className="text-foreground text-xs font-medium">{LIVE_HEADING}</h3>
      <p className="text-muted-foreground mt-1 text-xs">{activityVerb('streaming', activity)}</p>
    </section>
  );
}

/** A quiet line in place of the turns. */
function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-1 text-xs">{children}</p>;
}
