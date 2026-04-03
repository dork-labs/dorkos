import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Check, X } from 'lucide-react';
import type { ToolCallState, HookState } from '../model/use-chat-session';
import {
  getToolLabel,
  getMcpServerBadge,
  ToolArgumentsDisplay,
  cn,
  formatDuration,
} from '@/layers/shared/lib';
import { getToolStatusIcon, CollapsibleCard } from './primitives';
import { OutputRenderer } from './OutputRenderer';

/** Maximum characters to render before truncation (5KB). */
const TRUNCATE_THRESHOLD = 5120;

interface TruncatedOutputProps {
  /** Text content to display, truncated if over threshold. */
  content: string;
  /** Maximum characters before truncation. Defaults to TRUNCATE_THRESHOLD. */
  threshold?: number;
  /** Additional className for the wrapper div. */
  className?: string;
}

/** Renders text content with character-based truncation and a one-way expand button. */
function TruncatedOutput({
  content,
  threshold = TRUNCATE_THRESHOLD,
  className,
}: TruncatedOutputProps) {
  const [showFull, setShowFull] = useState(false);
  const isTruncated = content.length > threshold;
  const displayContent = isTruncated && !showFull ? content.slice(0, threshold) : content;

  return (
    <div className={cn('mt-2 border-t pt-2', className)}>
      <pre className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{displayContent}</pre>
      {isTruncated && !showFull && (
        <button
          onClick={() => setShowFull(true)}
          className="text-muted-foreground hover:text-foreground mt-1 text-xs underline"
        >
          Show full output ({(content.length / 1024).toFixed(1)}KB)
        </button>
      )}
    </div>
  );
}

interface HookRowProps {
  /** Single hook execution to display as a compact sub-row. */
  hook: HookState;
}

/** Status icon map for hook execution states. */
const hookStatusIcon = {
  running: <Loader2 className="text-muted-foreground size-(--size-icon-xs) animate-spin" />,
  success: <Check className="text-muted-foreground size-(--size-icon-xs)" />,
  error: <X className="text-destructive size-(--size-icon-xs)" />,
  cancelled: <X className="text-muted-foreground size-(--size-icon-xs)" />,
} satisfies Record<HookState['status'], React.ReactNode>;

/**
 * Compact sub-row for a single hook execution inside a tool call card.
 * Clickable to expand/collapse output. Error hooks start expanded.
 */
function HookRow({ hook }: HookRowProps) {
  const hasOutput = !!(hook.stdout || hook.stderr);
  const [expanded, setExpanded] = useState(hook.status === 'error');
  const output = hook.stderr || hook.stdout;

  return (
    <div>
      <button
        onClick={() => hasOutput && setExpanded((e) => !e)}
        className={cn('flex w-full items-center gap-1.5 py-0.5', !hasOutput && 'cursor-default')}
        aria-expanded={hasOutput ? expanded : undefined}
        disabled={!hasOutput}
      >
        {hookStatusIcon[hook.status]}
        <span
          className={cn(
            'text-3xs font-mono',
            hook.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {hook.hookName}
        </span>
        {hook.status === 'error' && <span className="text-3xs text-destructive">failed</span>}
        {hook.exitCode !== undefined && (
          <span className="text-3xs text-muted-foreground ml-auto">exit {hook.exitCode}</span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasOutput && output && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <pre className="text-muted-foreground max-h-32 overflow-y-auto py-1 text-xs whitespace-pre-wrap">
              {output}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface ToolCallCardProps {
  toolCall: ToolCallState;
  defaultExpanded?: boolean;
}

/** Expandable card displaying a tool call's status, arguments, and result. */
export function ToolCallCard({ toolCall, defaultExpanded = false }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const hasProgress = !!toolCall.progressOutput;

  useEffect(() => {
    if (hasProgress && !expanded) {
      setExpanded(true); // eslint-disable-line react-hooks/set-state-in-effect -- Intentional: auto-expand once when progress first arrives
    }
  }, [hasProgress]); // eslint-disable-line react-hooks/exhaustive-deps

  const hooksSection =
    toolCall.hooks && toolCall.hooks.length > 0 ? (
      <div className="border-border/50 space-y-0.5 border-t px-3 py-1">
        {toolCall.hooks.map((hook) => (
          <HookRow key={hook.hookId} hook={hook} />
        ))}
      </div>
    ) : undefined;

  const duration =
    toolCall.startedAt && toolCall.completedAt
      ? toolCall.completedAt - toolCall.startedAt
      : undefined;

  const badge = getMcpServerBadge(toolCall.toolName);

  return (
    <CollapsibleCard
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      dimmed={toolCall.status === 'complete'}
      extraContent={hooksSection}
      data-testid="tool-call-card"
      data-tool-name={toolCall.toolName}
      data-status={toolCall.status}
      header={
        <>
          {getToolStatusIcon(toolCall.status)}
          {badge && (
            <span className="bg-muted text-muted-foreground text-3xs rounded px-1 py-0.5 font-medium">
              {badge}
            </span>
          )}
          <span className="text-3xs flex-1 text-left font-mono">
            {getToolLabel(toolCall.toolName, toolCall.input)}
          </span>
          {duration !== undefined && (
            <span className="text-muted-foreground text-3xs tabular-nums">
              {formatDuration(duration)}
            </span>
          )}
        </>
      }
    >
      {toolCall.status === 'running' && !toolCall.input ? (
        <div className="text-muted-foreground flex items-center gap-1.5 py-1 text-xs">
          <Loader2 className="size-3 animate-spin" />
          <span>Preparing...</span>
        </div>
      ) : toolCall.input !== undefined && toolCall.input !== '' ? (
        <ToolArgumentsDisplay
          toolName={toolCall.toolName}
          input={toolCall.input}
          isStreaming={toolCall.status === 'running'}
        />
      ) : null}
      {toolCall.progressOutput && !toolCall.result && (
        <TruncatedOutput content={toolCall.progressOutput} />
      )}
      {toolCall.result && (
        <div className="mt-2 border-t pt-2">
          <OutputRenderer
            content={toolCall.result}
            toolName={toolCall.toolName}
            input={toolCall.input}
          />
        </div>
      )}
    </CollapsibleCard>
  );
}
