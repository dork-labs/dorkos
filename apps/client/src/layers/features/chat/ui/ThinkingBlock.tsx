import { useState, useEffect, useRef } from 'react';
import { Brain } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { CollapsibleCard } from './primitives';

interface ThinkingBlockProps {
  text: string;
  isStreaming: boolean;
  elapsedMs?: number;
}

/** Format thinking duration to a human-readable string. */
function formatThinkingDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Progressive disclosure collapsible block for Claude's extended thinking.
 *
 * Four visual states: streaming (open with breathing label), collapsing
 * (animated height transition), collapsed (chip with duration), expanded
 * (full content with max-height scroll cap).
 */
export function ThinkingBlock({ text, isStreaming, elapsedMs }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming);
  const wasStreamingRef = useRef(isStreaming);
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-collapse when streaming completes
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      setExpanded(false); // eslint-disable-line react-hooks/set-state-in-effect -- Intentional: collapse once on streaming→done transition
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Auto-scroll to bottom of content during streaming
  useEffect(() => {
    if (isStreaming && expanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [text, isStreaming, expanded]);

  const durationLabel = elapsedMs
    ? `Thought for ${formatThinkingDuration(elapsedMs)}`
    : 'Thinking...';

  return (
    <CollapsibleCard
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      variant="thinking"
      disabled={isStreaming}
      ariaLabel={durationLabel}
      data-testid="thinking-block"
      data-streaming={isStreaming ? 'true' : undefined}
      header={
        <>
          <Brain
            className={cn(
              'text-muted-foreground size-(--size-icon-xs)',
              isStreaming && 'animate-pulse'
            )}
          />
          <span
            className={cn(
              'text-3xs text-muted-foreground font-mono',
              isStreaming && 'animate-pulse'
            )}
          >
            {durationLabel}
          </span>
        </>
      }
    >
      <div ref={contentRef} className="max-h-64 overflow-y-auto">
        <pre className="text-muted-foreground text-xs break-words whitespace-pre-wrap">{text}</pre>
      </div>
    </CollapsibleCard>
  );
}
