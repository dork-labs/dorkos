/**
 * The two blocks a session's body draws that can take themselves away.
 *
 * A tool call and a thinking block are the same shape with a different inside:
 * both are noise once they are finished, both come back the moment something
 * goes wrong, and both leave with the same animation. Split out of
 * `AssistantMessageContent` when that file went over the 500-line bar — by PART
 * KIND rather than at a line count, so what moved is one idea rather than one
 * screenful.
 *
 * @module features/chat/ui/message/auto-hiding-parts
 */
import { useRef, useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { MessagePart } from '@dorkos/shared/types';
import { TIMING } from '@/layers/shared/lib';
import { McpAppBlock } from '@/layers/features/mcp-apps';
import { ToolCallCard } from '../tools/ToolCallCard';
import { ThinkingBlock } from './ThinkingBlock';
import type { HookState } from '@/layers/shared/model/chat-message-types';

/**
 * Derive the MCP server name from a namespaced MCP tool name
 * (`mcp__<server>__<tool>`). Returns undefined for non-MCP tools.
 */
function mcpServerFromToolName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  return toolName.split('__')[1] || undefined;
}

/**
 * Determines whether a tool call should be visible based on auto-hide settings.
 * If autoHide is enabled, tool calls that were already complete on mount are hidden immediately.
 * Tool calls that transition to complete are hidden after TIMING.TOOL_CALL_AUTO_HIDE_MS.
 */
function useToolCallVisibility(status: string, autoHide: boolean, hasFailedHook: boolean): boolean {
  const initialStatusRef = useRef(status);
  // eslint-disable-next-line react-hooks/refs -- Intentional: useState initializer runs once on mount
  const [visible, setVisible] = useState(!(autoHide && initialStatusRef.current === 'complete'));

  useEffect(() => {
    if (
      autoHide &&
      status === 'complete' &&
      initialStatusRef.current !== 'complete' &&
      !hasFailedHook
    ) {
      const timer = setTimeout(() => setVisible(false), TIMING.TOOL_CALL_AUTO_HIDE_MS);
      return () => clearTimeout(timer);
    }
  }, [status, autoHide, hasFailedHook]);

  if (!autoHide) return true;
  // Keep visible when a hook has failed, even if tool call is complete
  if (hasFailedHook) return true;
  return visible;
}

/**
 * Wraps a ToolCallCard with auto-hide animation behavior.
 * Uses AnimatePresence for exit animation when hiding.
 *
 * @param props - The tool call, and whether this reader hides finished ones.
 */
export function AutoHideToolCall({
  part,
  autoHide,
  expandToolCalls,
}: {
  part: {
    toolCallId: string;
    toolName: string;
    input?: string;
    result?: string;
    progressOutput?: string;
    status: 'pending' | 'running' | 'complete' | 'error';
    hooks?: HookState[];
    startedAt?: number;
    completedAt?: number;
  };
  autoHide: boolean;
  expandToolCalls: boolean;
}) {
  const hasFailedHook = part.hooks?.some((h) => h.status === 'error') ?? false;
  const visible = useToolCallVisibility(part.status, autoHide, hasFailedHook);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={part.toolCallId}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          <ToolCallCard
            toolCall={{
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input || '',
              result: part.result,
              progressOutput: part.progressOutput,
              status: part.status,
              hooks: part.hooks,
              startedAt: part.startedAt,
              completedAt: part.completedAt,
            }}
            defaultExpanded={expandToolCalls}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A tool card plus the inline MCP App its result points at (SEP-1865), when it
 * has one.
 *
 * Shared by the plain tool path and the approval-receipt path: an MCP tool that
 * had to ask permission first is still an MCP tool, and gating it must not cost
 * it its App. Renders exactly the card alone when there is no `ui://` reference
 * or the tool has not completed.
 *
 * @param props - The tool call, its session, and the two display preferences.
 */
export function ToolCallWithApp({
  part,
  sessionId,
  autoHide,
  expandToolCalls,
}: {
  part: Extract<MessagePart, { type: 'tool_call' }>;
  sessionId: string;
  autoHide: boolean;
  expandToolCalls: boolean;
}) {
  const mcpServer = part.ui ? mcpServerFromToolName(part.toolName) : undefined;
  const card = (
    <AutoHideToolCall part={part} autoHide={autoHide} expandToolCalls={expandToolCalls} />
  );
  if (!part.ui || part.status !== 'complete' || !mcpServer) return card;
  return (
    <div className="flex flex-col gap-2">
      {card}
      <McpAppBlock sessionId={sessionId} serverName={mcpServer} uri={part.ui.resourceUri} />
    </div>
  );
}

/**
 * Wraps a ThinkingBlock with auto-hide animation behavior.
 * Reuses useToolCallVisibility by mapping isStreaming to a status string.
 *
 * @param props - The thinking block, whether to hide it, and its position.
 */
export function AutoHideThinking({
  part,
  autoHide,
  index,
}: {
  part: { text: string; isStreaming?: boolean; elapsedMs?: number };
  autoHide: boolean;
  index: number;
}) {
  const status = part.isStreaming ? 'running' : 'complete';
  const visible = useToolCallVisibility(status, autoHide, false);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={`thinking-${index}`}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          <ThinkingBlock
            text={part.text}
            isStreaming={part.isStreaming ?? false}
            elapsedMs={part.elapsedMs}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
