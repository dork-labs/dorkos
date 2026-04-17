import { useState, useEffect, useRef } from 'react';
import { BookOpen, Sparkles, User, Users } from 'lucide-react';
import { toast } from 'sonner';
import { cn, truncateMiddle } from '@/layers/shared/lib';
import { CollapsibleCard } from '../primitives';

interface MemoryEntry {
  path: string;
  scope: 'personal' | 'team';
  content?: string;
}

interface MemoryRecallBlockProps {
  mode: 'select' | 'synthesize';
  memories: MemoryEntry[];
  isStreaming: boolean;
}

/**
 * Top-of-bubble lifecycle indicator for SDK memory_recall events.
 *
 * Four visual states mirroring ThinkingBlock: streaming (breathing label),
 * collapsing (auto on stream end), collapsed chip ("Recalled N memories"),
 * expanded (vertical list of recalled paths or synthesis paragraph).
 *
 * @param mode - Whether Claude selected discrete memory files or synthesized across a directory.
 * @param memories - Array of recalled memory entries, each with a path and optional synthesis content.
 * @param isStreaming - True while the memory_recall event stream is in progress.
 */
export function MemoryRecallBlock({ mode, memories, isStreaming }: MemoryRecallBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming);
  const wasStreamingRef = useRef(isStreaming);

  // Auto-collapse when streaming completes — mirrors ThinkingBlock exactly
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      setExpanded(false); // eslint-disable-line react-hooks/set-state-in-effect -- Intentional: collapse once on streaming→done transition
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  if (memories.length === 0) {
    // Defense in depth: a memory_recall part with zero memories is a bug upstream.
    // Render nothing rather than an empty chip.
    return null;
  }

  const count = memories.length;
  const headerLabel = isStreaming
    ? count <= 1
      ? 'Consulting memory…'
      : `Consulting ${count} memories…`
    : count === 1
      ? 'Recalled 1 memory'
      : `Recalled ${count} memories`;

  const HeaderIcon = mode === 'synthesize' ? Sparkles : BookOpen;
  const headerIconName = mode === 'synthesize' ? 'sparkles' : 'bookopen';

  return (
    <CollapsibleCard
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      variant="memory"
      dimmed={!isStreaming}
      disabled={isStreaming}
      ariaLabel={headerLabel}
      data-testid="memory-recall-block"
      data-streaming={isStreaming ? 'true' : undefined}
      header={
        <>
          <HeaderIcon
            aria-hidden="true"
            data-testid="memory-recall-header-icon"
            data-icon={headerIconName}
            className={cn(
              'text-muted-foreground size-(--size-icon-xs)',
              isStreaming && 'animate-tasks'
            )}
          />
          <span
            className={cn(
              'text-3xs text-muted-foreground font-mono',
              isStreaming && 'animate-tasks'
            )}
          >
            {headerLabel}
          </span>
        </>
      }
    >
      <MemoryRecallList memories={memories} />
    </CollapsibleCard>
  );
}

// ---------------------------------------------------------------------------
// Inner components — kept in this file because the total stays under 200 lines.
// ---------------------------------------------------------------------------

function MemoryRecallList({ memories }: { memories: MemoryEntry[] }) {
  return (
    <ul className="flex flex-col gap-1 px-3 py-2">
      {memories.map((m) => (
        <MemoryRecallRow key={m.path} memory={m} />
      ))}
    </ul>
  );
}

function MemoryRecallRow({ memory }: { memory: MemoryEntry }) {
  const isSynthesis = memory.path.startsWith('<synthesis:');
  const ScopeIcon = memory.scope === 'team' ? Users : User;
  const scopeWord = memory.scope === 'team' ? 'team' : 'personal';

  const handleCopy = async () => {
    const payload = isSynthesis && memory.content ? memory.content : memory.path;
    try {
      await navigator.clipboard.writeText(payload);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  if (isSynthesis && memory.content) {
    const displayDir = memory.path.replace(/^<synthesis:/, 'synthesis:').replace(/>$/, '');
    return (
      <li>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`Copy synthesized ${scopeWord} memory content`}
          data-scope={memory.scope}
          className="focus-ring hover:bg-muted/50 flex min-h-[44px] w-full flex-col items-start gap-1 rounded-md px-2 py-1 text-left"
        >
          <span className="text-sm">{memory.content}</span>
          <span className="text-3xs text-muted-foreground flex items-center gap-1 font-mono">
            <ScopeIcon aria-hidden="true" className="size-(--size-icon-xs)" />
            {displayDir}
          </span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy ${scopeWord} memory path ${memory.path}`}
        data-scope={memory.scope}
        className="focus-ring hover:bg-muted/50 flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-1 text-left"
      >
        <span className="flex-1 truncate font-mono text-sm">{truncateMiddle(memory.path, 40)}</span>
        <ScopeIcon aria-hidden="true" className="text-muted-foreground size-(--size-icon-xs)" />
      </button>
    </li>
  );
}
