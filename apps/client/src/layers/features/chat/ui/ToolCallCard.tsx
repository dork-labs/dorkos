import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Check, X, ChevronDown } from 'lucide-react';
import type { ToolCallState } from '../model/use-chat-session';
import { getToolLabel, ToolArgumentsDisplay, cn } from '@/layers/shared/lib';
import { toolStatus } from './message/message-variants';

interface ToolCallCardProps {
  toolCall: ToolCallState;
  defaultExpanded?: boolean;
}

/** Expandable card displaying a tool call's status, arguments, and result. */
export function ToolCallCard({ toolCall, defaultExpanded = false }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const statusIcon = {
    pending: (
      <Loader2 className={cn('size-(--size-icon-xs) animate-spin', toolStatus({ status: 'pending' }))} />
    ),
    running: (
      <Loader2 className={cn('size-(--size-icon-xs) animate-spin', toolStatus({ status: 'running' }))} />
    ),
    complete: <Check className={cn('size-(--size-icon-xs)', toolStatus({ status: 'complete' }))} />,
    error: <X className={cn('size-(--size-icon-xs)', toolStatus({ status: 'error' }))} />,
  }[toolCall.status];

  return (
    <div
      className="bg-muted/50 hover:border-border mt-px rounded-msg-tool border text-sm shadow-msg-tool transition-all duration-150 first:mt-1 hover:shadow-msg-tool-hover"
      data-testid="tool-call-card"
      data-tool-name={toolCall.toolName}
      data-status={toolCall.status}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1"
        aria-expanded={expanded}
      >
        {statusIcon}
        <span className="text-3xs font-mono">
          {getToolLabel(toolCall.toolName, toolCall.input)}
        </span>
        <motion.div
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="ml-auto"
        >
          <ChevronDown className="size-(--size-icon-xs)" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t px-3 pt-1 pb-3">
              {toolCall.input && (
                <ToolArgumentsDisplay toolName={toolCall.toolName} input={toolCall.input} />
              )}
              {toolCall.result && (
                <pre className="mt-2 overflow-x-auto border-t pt-2 text-xs whitespace-pre-wrap">
                  {toolCall.result}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
