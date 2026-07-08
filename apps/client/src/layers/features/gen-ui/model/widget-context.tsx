/**
 * Action wiring for rendered widgets. A single context carries the `onAction`
 * dispatcher and the agent-actions feature flag down to interactive nodes
 * (buttons, list actions, form submits) without prop-drilling through the
 * recursive renderer.
 *
 * @module features/gen-ui/model/widget-context
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { WidgetAction } from '@dorkos/shared/ui-widget';
import { executeUiCommand, type DispatcherContext } from '@/layers/shared/lib';
import { useAppStore, useTheme } from '@/layers/shared/model';
import { WIDGET_AGENT_ACTIONS_ENABLED } from '../config/feature-flags';

/** The action surface exposed to interactive widget nodes. */
export interface WidgetActionsValue {
  /** Dispatch a widget action (`ui` local, `url` link-out; `agent` is PR E). */
  onAction: (action: WidgetAction) => void;
  /** Whether `agent`-kind actions are enabled (false until PR E). */
  agentActionsEnabled: boolean;
}

const noop = () => {};

const WidgetActionsContext = createContext<WidgetActionsValue>({
  onAction: noop,
  agentActionsEnabled: WIDGET_AGENT_ACTIONS_ENABLED,
});

/**
 * Provide the widget action dispatcher to a rendered widget tree. Wraps
 * {@link executeUiCommand} for `ui` actions and opens external links for `url`
 * actions; `agent` actions are inert here (nodes render them disabled until PR E).
 */
export function WidgetActionProvider({ children }: { children: ReactNode }) {
  const { setTheme } = useTheme();

  const onAction = useCallback(
    (action: WidgetAction) => {
      switch (action.kind) {
        case 'ui': {
          // getState() snapshot at call-time — the dispatcher is a pure side effect.
          const ctx = {
            store: useAppStore.getState(),
            setTheme,
          } as unknown as DispatcherContext;
          executeUiCommand(ctx, action.command);
          break;
        }
        case 'url':
          window.open(action.href, '_blank', 'noopener,noreferrer');
          break;
        case 'agent':
          // The interaction channel ships in PR E; nodes disable agent actions,
          // so this branch is unreachable while the flag is off.
          break;
      }
    },
    [setTheme]
  );

  const value = useMemo<WidgetActionsValue>(
    () => ({ onAction, agentActionsEnabled: WIDGET_AGENT_ACTIONS_ENABLED }),
    [onAction]
  );

  return <WidgetActionsContext.Provider value={value}>{children}</WidgetActionsContext.Provider>;
}

/** Access the widget action dispatcher and agent-actions flag. */
export function useWidgetActions(): WidgetActionsValue {
  return useContext(WidgetActionsContext);
}
