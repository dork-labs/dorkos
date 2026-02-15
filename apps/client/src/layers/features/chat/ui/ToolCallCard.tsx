import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Check, X, ChevronDown } from 'lucide-react';
import type { ToolCallState } from '../model/use-chat-session';
import { getToolLabel, ToolArgumentsDisplay } from '@/layers/shared/lib';

interface ToolCallCardProps {
  toolCall: ToolCallState;
  defaultExpanded?: boolean;
}

export function ToolCallCard({ toolCall, defaultExpanded = false }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const statusIcon = {
    pending: <Loader2 className="size-(--size-icon-xs) animate-spin" />,
    running: <Loader2 className="size-(--size-icon-xs) animate-spin text-blue-500" />,
    complete: <Check className="size-(--size-icon-xs) text-green-500" />,
    error: <X className="size-(--size-icon-xs) text-red-500" />,
  }[toolCall.status];

  return (
    <div className="mt-px first:mt-1 rounded border bg-muted/50 text-sm transition-all duration-150 hover:border-border hover:shadow-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1"
      >
        {statusIcon}
        <span className="font-mono text-3xs">{getToolLabel(toolCall.toolName, toolCall.input)}</span>
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
            <div className="border-t px-3 pb-3 pt-1">
              {toolCall.input && (
                <ToolArgumentsDisplay toolName={toolCall.toolName} input={toolCall.input} />
              )}
              {toolCall.result && (
                <pre className="mt-2 text-xs overflow-x-auto border-t pt-2 whitespace-pre-wrap">
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
