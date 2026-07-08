/**
 * Action wiring for rendered widgets. A single context carries the `onAction`
 * dispatcher down to interactive nodes (buttons, list actions, form submits)
 * without prop-drilling through the recursive renderer.
 *
 * Dispatch by kind: `ui` runs locally via {@link executeUiCommand}; `url`
 * confirms through the shared {@link LinkSafetyModal} (spec D4 — same
 * conventions as chat links) before opening in a new tab; `agent` POSTs back to
 * the session via the Transport's `sendUiAction` — the generative-UI
 * interactivity return channel (spec gen-ui-tier1 §3). `agent` actions require
 * a target session, so they are only enabled when the widget is rendered with a
 * `sessionId` (chat, canvas); off a session (e.g. the dev playground) they
 * render disabled.
 *
 * @module features/gen-ui/model/widget-context
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { WidgetAction } from '@dorkos/shared/ui-widget';
import { executeUiCommand, type DispatcherContext } from '@/layers/shared/lib';
import { LinkSafetyModal } from '@/layers/shared/ui';
import { useAppStore, useTheme, useTransport } from '@/layers/shared/model';

/** The action surface exposed to interactive widget nodes. */
export interface WidgetActionsValue {
  /**
   * Dispatch a widget action. `ui`/`url` resolve synchronously (`url` defers
   * the actual open to the link-safety confirmation); `agent` resolves once the
   * return-channel POST settles (rejects on failure so the caller can clear its
   * pending state and surface an error).
   */
  onAction: (action: WidgetAction) => Promise<void>;
  /** Whether `agent`-kind actions can be dispatched (true when a target session exists). */
  agentActionsEnabled: boolean;
}

const noop = () => Promise.resolve();

const WidgetActionsContext = createContext<WidgetActionsValue>({
  onAction: noop,
  agentActionsEnabled: false,
});

interface WidgetActionProviderProps {
  children: ReactNode;
  /** The session that rendered the widget; required to dispatch `agent` actions. */
  sessionId?: string;
  /** The widget document title, forwarded to the agent so it knows which widget fired. */
  widgetTitle?: string;
}

/**
 * Provide the widget action dispatcher to a rendered widget tree. `ui` actions
 * dispatch through {@link executeUiCommand}; `url` actions confirm through the
 * shared {@link LinkSafetyModal} before opening in a new tab; `agent` actions
 * POST through the Transport's `sendUiAction` return channel.
 */
export function WidgetActionProvider({
  children,
  sessionId,
  widgetTitle,
}: WidgetActionProviderProps) {
  const { setTheme } = useTheme();
  const transport = useTransport();
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  const onAction = useCallback(
    async (action: WidgetAction): Promise<void> => {
      switch (action.kind) {
        case 'ui': {
          // getState() snapshot at call-time — the dispatcher is a pure side effect.
          const ctx: DispatcherContext = { store: useAppStore.getState(), setTheme };
          executeUiCommand(ctx, action.command);
          return;
        }
        case 'url':
          // Never open directly — the user confirms via the link-safety modal.
          setPendingUrl(action.href);
          return;
        case 'agent':
          // Guarded by `agentActionsEnabled` at the node level; this is defensive.
          if (!sessionId) return;
          await transport.sendUiAction(sessionId, {
            actionId: action.id,
            payload: action.payload,
            widgetTitle,
          });
          return;
      }
    },
    [setTheme, transport, sessionId, widgetTitle]
  );

  const value = useMemo<WidgetActionsValue>(
    () => ({ onAction, agentActionsEnabled: Boolean(sessionId) }),
    [onAction, sessionId]
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

/** Access the widget action dispatcher and agent-actions flag. */
export function useWidgetActions(): WidgetActionsValue {
  return useContext(WidgetActionsContext);
}
