import { Panel, PanelGroup } from 'react-resizable-panels';
import { ChatPanel } from '@/layers/features/chat';
import { AgentCanvas } from '@/layers/features/canvas';
import { useSessionId } from '@/layers/entities/session';

/**
 * Session route page — wraps ChatPanel with route-derived session ID.
 *
 * Renders a horizontal `PanelGroup` so that `AgentCanvas` can open as a
 * resizable right-hand panel alongside the chat. When the canvas is closed
 * it returns null and the chat panel expands to fill the full width.
 */
export function SessionPage() {
  const [activeSessionId] = useSessionId();

  return (
    <PanelGroup direction="horizontal" autoSaveId="agent-canvas">
      <Panel id="chat" order={1} minSize={30} defaultSize={100}>
        <ChatPanel sessionId={activeSessionId} />
      </Panel>
      <AgentCanvas />
    </PanelGroup>
  );
}
