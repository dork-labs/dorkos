import { useContext } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { PanelResourceVisible, useAppStore } from '@/layers/shared/model';
import { useSessionId, useSessionRow } from '@/layers/entities/session';
import { useCurrentAgent } from '@/layers/entities/agent';
import { LocalBrowserPanel } from './LocalBrowserPanel';

/** A panel's route scopes sharing; room routes never inherit the last direct chat. */
export function LocalBrowserContent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [sessionId] = useSessionId();
  const directSessionId = pathname === '/session' ? sessionId : null;
  const { data: session } = useSessionRow(directSessionId, {
    enabled: !!directSessionId,
    nameOnly: true,
  });
  const { data: agent } = useCurrentAgent(session?.cwd ?? null);
  const resourceVisible = useContext(PanelResourceVisible);
  const open = useAppStore((state) => state.rightPanelOpen);
  const active = useAppStore((state) => state.activeRightPanelTab);
  return (
    <LocalBrowserPanel
      key={pathname === '/session' ? `chat:${sessionId ?? ''}` : 'human-only'}
      visible={resourceVisible && open && active === 'local-browser'}
      sessionId={pathname === '/session' ? sessionId : null}
      agentName={pathname === '/session' ? agent?.name : null}
    />
  );
}
