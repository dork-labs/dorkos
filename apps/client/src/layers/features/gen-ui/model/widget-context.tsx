/**
 * Action wiring for rendered widgets. A single context carries the `onAction`
 * dispatcher — plus per-widget-instance latch/dispatch state — down to
 * interactive nodes (buttons, list actions, form submits, board cells) without
 * prop-drilling through the recursive renderer.
 *
 * Dispatch by kind: `ui` runs locally via {@link executeUiCommand}; `url`
 * confirms through the shared {@link LinkSafetyModal} (spec D4 — same
 * conventions as chat links) before opening in a new tab; `agent` POSTs back to
 * the session via the Transport's `sendUiAction` — the generative-UI
 * interactivity return channel (spec gen-ui-tier1 §3).
 *
 * `agent` actions require a target session, so they are only enabled when the
 * widget is rendered with a `sessionId` (chat, canvas); off a session (e.g. the
 * dev playground) they render disabled. They are additionally inert once the
 * widget is SUPERSEDED (no longer the latest message — a stale board must not
 * accept a move) or LATCHED (a dispatch from this widget instance is in flight
 * or settled — one interaction per widget render).
 *
 * On an `agent` dispatch the provider also (a) latches the widget, (b) posts an
 * optimistic `<ui_action>` user message into the session stream so the person's
 * interaction renders instantly — live and after reload look identical (the
 * server persists the same block) — and (c) marks the trigger pending so the
 * composer reads `streaming` immediately (CLI-B7 parity with a typed send).
 *
 * @module features/gen-ui/model/widget-context
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { formatUiActionMessage, type WidgetAction } from '@dorkos/shared/ui-widget';
import {
  executeUiCommand,
  TIMING,
  type CelebrationOrigin,
  type DispatcherContext,
} from '@/layers/shared/lib';
import { LinkSafetyModal } from '@/layers/shared/ui';
import { useAppStore, useTheme, useTransport } from '@/layers/shared/model';
import { useSessionStreamStore } from '@/layers/entities/session';

/** Settle phase of the widget's single in-flight/settled `agent` dispatch. */
export type DispatchStatus = 'idle' | 'pending' | 'sent';

/** The action surface exposed to interactive widget nodes. */
export interface WidgetActionsValue {
  /**
   * Dispatch a widget action. `ui`/`url` resolve synchronously (`url` defers
   * the actual open to the link-safety confirmation); `agent` resolves once the
   * return-channel POST settles (rejects on failure so the caller can surface an
   * error — the provider has already un-latched by then).
   *
   * @param action - The action to dispatch.
   * @param opts - Optional dispatch hints. `origin` is the normalized viewport
   *   point a resulting `celebrate` command erupts from (the clicked control's
   *   center), so confetti bursts out of the button rather than screen-center.
   */
  onAction: (action: WidgetAction, opts?: { origin?: CelebrationOrigin }) => Promise<void>;
  /** Whether `agent`-kind actions can be dispatched (true when a target session exists). */
  agentActionsEnabled: boolean;
  /**
   * Whether this widget is superseded — a later message exists, so its `agent`
   * actions are inert (readable, not clickable). `ui`/`url` actions stay live.
   */
  superseded: boolean;
  /** True once an `agent` action from this widget instance has been dispatched. */
  latched: boolean;
  /** The id of the dispatched `agent` action, or `null`. */
  dispatchedActionId: string | null;
  /** Settle phase of the dispatched `agent` action. */
  dispatchStatus: DispatchStatus;
}

const noop = () => Promise.resolve();

const WidgetActionsContext = createContext<WidgetActionsValue>({
  onAction: noop,
  agentActionsEnabled: false,
  superseded: false,
  latched: false,
  dispatchedActionId: null,
  dispatchStatus: 'idle',
});

interface WidgetActionProviderProps {
  children: ReactNode;
  /** The session that rendered the widget; required to dispatch `agent` actions. */
  sessionId?: string;
  /** The widget document title, forwarded to the agent so it knows which widget fired. */
  widgetTitle?: string;
  /**
   * Whether this widget is rendered in the LATEST message of the conversation.
   * Defaults to `true` (surfaces with no message context — the dev playground,
   * standalone renders — are always live). `false` marks the widget superseded:
   * its `agent` actions render inert so a stale board can't accept a move.
   */
  isLatestMessage?: boolean;
}

/** The provider's single dispatch record — which action fired and how far it got. */
interface DispatchRecord {
  actionId: string;
  status: DispatchStatus;
}

/**
 * Provide the widget action dispatcher to a rendered widget tree, along with the
 * per-instance latch/supersede state every interactive node reads via
 * {@link useWidgetActions} / {@link useAgentActionState}.
 */
export function WidgetActionProvider({
  children,
  sessionId,
  widgetTitle,
  isLatestMessage = true,
}: WidgetActionProviderProps) {
  const { setTheme } = useTheme();
  const transport = useTransport();
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [dispatch, setDispatch] = useState<DispatchRecord | null>(null);
  // SYNCHRONOUS latch mirror. The React state above is for rendering only — it
  // does not update between two same-tick dispatches (a fast double-click, or
  // several clicks in one synchronous burst), so guarding on it alone let every
  // click in the burst POST (observed: three moves fired back-to-back). This
  // ref is checked-and-set inside `onAction` BEFORE any await, closing the
  // window; the failure path clears it (the un-latch).
  const dispatchedRef = useRef(false);

  const onAction = useCallback(
    async (action: WidgetAction, opts?: { origin?: CelebrationOrigin }): Promise<void> => {
      switch (action.kind) {
        case 'ui': {
          // getState() snapshot at call-time — the dispatcher is a pure side effect.
          // `supportsTerminal` keeps `open_terminal` degrading gracefully on a
          // transport with no terminal (DirectTransport/Obsidian), matching the
          // agent-stream dispatch path. `celebrationOrigin` makes a `celebrate`
          // command erupt from the clicked control (origin-aware confetti).
          const ctx: DispatcherContext = {
            store: useAppStore.getState(),
            setTheme,
            supportsTerminal: transport.supportsTerminal,
            celebrationOrigin: opts?.origin,
          };
          // Origin 'user': widget actions only fire when the person clicks a
          // widget button, so a resulting tab switch is an explicit pick and
          // persists the per-agent preference (DOR-227).
          executeUiCommand(ctx, action.command, 'user');
          return;
        }
        case 'url':
          // Never open directly — the user confirms via the link-safety modal.
          setPendingUrl(action.href);
          return;
        case 'agent': {
          // Guarded by the node level; this is defensive.
          if (!sessionId) return;
          // Re-entrancy gate: the node-level `interactive` check reads React
          // state, which is stale within the same tick — this ref is the
          // authoritative one-dispatch-per-widget-instance guard.
          if (dispatchedRef.current) return;
          dispatchedRef.current = true;
          const request = { actionId: action.id, payload: action.payload, widgetTitle };
          const streamStore = useSessionStreamStore.getState();
          // Render the interaction instantly and consistently: the optimistic
          // block matches what the server persists as the real user turn, so the
          // live chip and the reloaded chip are the same jewel. Latch the widget
          // and the composer's trigger window in the same beat.
          streamStore.setOptimisticUserMessage(sessionId, {
            id: crypto.randomUUID(),
            content: formatUiActionMessage(request),
          });
          streamStore.setTriggerPending(sessionId, true);
          setDispatch({ actionId: action.id, status: 'pending' });
          try {
            await transport.sendUiAction(sessionId, request);
            setDispatch({ actionId: action.id, status: 'sent' });
            // Watchdog: a 202 whose turn never materializes must not wedge the
            // composer in `streaming` — release the trigger latch if no
            // `turn_start` arrived. One-shot, reads live state, no-op once the
            // turn started. (No rekey path — ui-actions only fire in an
            // already-established session.)
            setTimeout(() => {
              const s = useSessionStreamStore.getState().getSession(sessionId);
              if (s.triggerPending && s.status?.lifecycle !== 'streaming') {
                useSessionStreamStore.getState().setTriggerPending(sessionId, false);
              }
            }, TIMING.TRIGGER_PENDING_TIMEOUT_MS);
          } catch (err) {
            // Failure — un-latch (ref AND render state), drop the optimistic
            // message and the trigger latch, and rethrow so the node reverts
            // its optimistic mark and toasts.
            dispatchedRef.current = false;
            streamStore.setOptimisticUserMessage(sessionId, null);
            streamStore.setTriggerPending(sessionId, false);
            setDispatch(null);
            throw err;
          }
          return;
        }
      }
    },
    [setTheme, transport, sessionId, widgetTitle]
  );

  const value = useMemo<WidgetActionsValue>(
    () => ({
      onAction,
      agentActionsEnabled: Boolean(sessionId),
      superseded: !isLatestMessage,
      latched: dispatch !== null,
      dispatchedActionId: dispatch?.actionId ?? null,
      dispatchStatus: dispatch?.status ?? 'idle',
    }),
    [onAction, sessionId, isLatestMessage, dispatch]
  );

  return (
    <WidgetActionsContext.Provider value={value}>
      {children}
      <LinkSafetyModal
        url={pendingUrl ?? ''}
        isOpen={pendingUrl !== null}
        onClose={() => setPendingUrl(null)}
        onConfirm={() => {
          if (pendingUrl) window.open(pendingUrl, '_blank', 'noopener,noreferrer');
          setPendingUrl(null);
        }}
      />
    </WidgetActionsContext.Provider>
  );
}

/** Access the widget action dispatcher and per-instance latch/supersede flags. */
export function useWidgetActions(): WidgetActionsValue {
  return useContext(WidgetActionsContext);
}

/** Resolved interaction state for a single action, derived from the widget context. */
export interface AgentActionState {
  /** Whether the action posts back to the agent (vs a local `ui`/`url` action). */
  isAgent: boolean;
  /** No target session → cannot dispatch (e.g. the dev playground). */
  unavailable: boolean;
  /** A later message exists → this `agent` action is inert. */
  superseded: boolean;
  /** The widget is latched by a dispatch and this action is not the one that fired. */
  latched: boolean;
  /** This specific `agent` action is the one that was dispatched. */
  isDispatched: boolean;
  /** Settle phase — only meaningful when {@link isDispatched}. */
  dispatchStatus: DispatchStatus;
  /** Whether the control may be clicked. `ui`/`url` actions are always interactive. */
  interactive: boolean;
}

/**
 * Resolve the interaction state for a single widget action against the current
 * widget-context latch/supersede state. `agent` actions gate on session
 * presence, supersede, and latch; `ui`/`url` actions are always interactive.
 *
 * @param action - The action a node is about to render a control for.
 */
export function useAgentActionState(action: WidgetAction): AgentActionState {
  const { agentActionsEnabled, superseded, latched, dispatchedActionId, dispatchStatus } =
    useWidgetActions();
  const isAgent = action.kind === 'agent';
  const isDispatched = isAgent && dispatchedActionId !== null && action.id === dispatchedActionId;
  const unavailable = isAgent && !agentActionsEnabled;
  const isSuperseded = isAgent && superseded;
  const isLatchedOther = isAgent && latched && !isDispatched;
  const interactive = isAgent ? !unavailable && !isSuperseded && !latched : true;
  return {
    isAgent,
    unavailable,
    superseded: isSuperseded,
    latched: isLatchedOther,
    isDispatched,
    dispatchStatus: isDispatched ? dispatchStatus : 'idle',
    interactive,
  };
}
