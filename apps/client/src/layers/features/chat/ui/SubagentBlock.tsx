import { useState } from 'react';
import type { SubagentPart } from '@dorkos/shared/types';
import { getToolStatusIcon, CollapsibleCard } from './primitives';

interface SubagentBlockProps {
  part: SubagentPart;
}

/** Format duration from milliseconds to human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Build a tool usage summary string from subagent progress metrics. */
function buildToolSummary(part: SubagentPart): string | null {
  const segments: string[] = [];
  if (part.toolUses) {
    segments.push(`${part.toolUses} tool ${part.toolUses === 1 ? 'call' : 'calls'}`);
  }
  if (part.durationMs) {
    segments.push(formatDuration(part.durationMs));
  }
  return segments.length > 0 ? segments.join(' \u00b7 ') : null;
}

/** Collapsible inline block displaying a subagent's lifecycle status. */
export function SubagentBlock({ part }: SubagentBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const toolSummary = buildToolSummary(part);
  const hasExpandableContent = toolSummary || part.summary || part.lastToolName;

  return (
    <CollapsibleCard
      expanded={expanded}
      onToggle={() => hasExpandableContent && setExpanded(!expanded)}
      hideChevron={!hasExpandableContent}
      ariaLabel={`Subagent: ${part.description}`}
      data-testid="subagent-block"
      data-task-id={part.taskId}
      data-status={part.status}
      header={
        <>
          {getToolStatusIcon(part.status)}
          <span className="text-3xs font-mono truncate">{part.description}</span>
          {toolSummary && (
            <span className="text-3xs text-muted-foreground ml-1 shrink-0">{toolSummary}</span>
          )}
        </>
      }
    >
      <div className="space-y-1">
        {part.lastToolName && part.status === 'running' && (
          <p className="text-3xs text-muted-foreground">
            Last tool: <span className="font-mono">{part.lastToolName}</span>
          </p>
        )}
        {part.summary && (
          <pre className="text-xs whitespace-pre-wrap overflow-x-auto">
            {part.summary}
          </pre>
        )}
      </div>
    </CollapsibleCard>
  );
}
