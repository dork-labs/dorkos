import { useLayoutEffect, useMemo, useRef } from 'react';
import type { PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import {
  McpAppFrame,
  type McpAppDocHost,
  type McpAppDocProjection,
} from '@/layers/features/mcp-apps';
import { useSessionId } from '@/layers/entities/session';
import { useDocChannel } from '../model/use-doc-channel';

interface CanvasMcpAppContentProps {
  /** Actual original Canvas hosting document, never selected by an App. */
  documentId: string;
  /** MCP App canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'mcp_app' }>;
}

/** Compose the original native Doc permission into the public MCP hosting callback contract. */
export function CanvasMcpAppContent({ documentId, content }: CanvasMcpAppContentProps) {
  const doc = useDocChannel(documentId);
  const [activeSessionId] = useSessionId();
  const current = useRef({ doc, documentId, content });
  const listeners = useRef(new Set<(projection: McpAppDocProjection) => void>());
  const binding = doc.mcpBinding;
  const host = useMemo<McpAppDocHost | undefined>(() => {
    if (
      !binding ||
      binding.documentId !== documentId ||
      binding.origin.serverName !== content.serverName ||
      binding.origin.uri !== content.uri
    )
      return undefined;
    const permitted = () => {
      const own = current.current;
      return (
        own.documentId === documentId &&
        own.doc.mcpBinding === binding &&
        own.content.serverName === binding.origin.serverName &&
        own.content.uri === binding.origin.uri &&
        binding.current('read')
      );
    };
    return Object.freeze({
      documentId,
      generation: binding.generation,
      owner: binding.owner,
      current: permitted,
      captureOriginal: (event: PageEvent) => {
        if (!permitted()) return null;
        const original = binding.captureOriginal(event);
        return permitted() ? original : null;
      },
      subscribe: (receive: (projection: McpAppDocProjection) => void) => {
        listeners.current.add(receive);
        const own = current.current.doc;
        if (permitted() && own.snapshot)
          receive({
            events: own.events,
            state: own.snapshot.state,
            stateRev: own.snapshot.stateRev,
            docSeq: own.snapshot.highWatermark,
            resetRequired: own.snapshot.resetRequired,
            receipts: own.snapshot.receipts,
          });
        const captured = listeners.current;
        return () => captured.delete(receive);
      },
    });
  }, [binding, documentId, content.serverName, content.uri]);
  useLayoutEffect(() => {
    current.current = { doc, documentId, content };
    if (!host?.current() || !doc.snapshot) return;
    const projection: McpAppDocProjection = {
      events: doc.events,
      state: doc.snapshot.state,
      stateRev: doc.snapshot.stateRev,
      docSeq: doc.snapshot.highWatermark,
      resetRequired: doc.snapshot.resetRequired,
      receipts: doc.snapshot.receipts,
    };
    for (const receive of listeners.current) receive(projection);
  }, [doc, documentId, content, host]);
  // Eligible extensions use the authenticated stored source. Render-only fallback retains
  // the existing active-session resource context and grants no Doc permission.
  if (
    binding &&
    (binding.origin.serverName !== content.serverName || binding.origin.uri !== content.uri)
  )
    return <div className="text-muted-foreground p-4 text-sm">This app is unavailable here.</div>;
  const resourceSessionId = binding?.origin.canonicalSessionId ?? activeSessionId;
  if (!resourceSessionId) return null;
  return (
    <div className="h-full w-full">
      <McpAppFrame
        sessionId={resourceSessionId}
        serverName={content.serverName}
        uri={content.uri}
        title={content.title}
        docHost={host}
      />
    </div>
  );
}
