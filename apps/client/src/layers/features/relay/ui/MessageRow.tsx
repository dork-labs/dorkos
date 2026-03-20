import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Clock, Check, AlertTriangle, MailX, Activity } from 'lucide-react';
import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { MessageTrace } from './MessageTrace';
import { getStatusBorderColor } from '../lib/status-colors';
import { resolveSubjectLabelLocal } from '../lib/resolve-label';
import { formatTimeAgo } from '../lib/format-time';

interface MessageRowProps {
  message: Record<string, unknown>;
}

const STATUS_CONFIG: Record<string, { icon: React.ElementType; className: string; label: string }> =
  {
    new: { icon: Clock, className: 'text-muted-foreground', label: 'New' },
    cur: { icon: Check, className: 'text-muted-foreground', label: 'Delivered' },
    failed: { icon: AlertTriangle, className: 'text-destructive', label: 'Failed' },
    dead_letter: { icon: MailX, className: 'text-amber-500', label: 'Dead Letter' },
  };

const PREVIEW_MAX_LENGTH = 80;

/** Extract a short preview string from an unknown payload value. */
function extractPreview(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  const text = p.content ?? p.text ?? p.message ?? p.body;
  if (typeof text === 'string') {
    return text.length > PREVIEW_MAX_LENGTH ? text.slice(0, PREVIEW_MAX_LENGTH) + '...' : text;
  }
  const json = JSON.stringify(payload);
  return json.length > PREVIEW_MAX_LENGTH ? json.slice(0, PREVIEW_MAX_LENGTH) + '...' : json;
}

/** Compact/expanded message card with status indicators, payload view, and trace toggle. */
export function MessageRow({ message }: MessageRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const status = (message.status as string) ?? 'new';
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.new;
  const StatusIcon = config.icon;
  const messageId = message.id as string;

  const borderColor = getStatusBorderColor(status === 'cur' ? 'delivered' : status);

  const preview = extractPreview(message.payload);

  return (
    <div
      className={cn(
        'hover:bg-muted/50 w-full rounded-lg border border-l-2 text-left transition-colors hover:shadow-sm',
        borderColor,
        expanded && 'bg-muted/30'
      )}
    >
      <button type="button" onClick={() => setExpanded(!expanded)} className="w-full p-3">
        <div className="flex items-center gap-2">
          <StatusIcon className={cn('size-4 shrink-0', config.className)} />
          <span className="min-w-0 flex-1 truncate text-sm">
            {resolveSubjectLabelLocal(message.subject as string)}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs">{message.from as string}</span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {message.createdAt ? formatTimeAgo(message.createdAt as string) : ''}
          </span>
          <Badge variant="outline" className="shrink-0 text-xs">
            {config.label}
          </Badge>
        </div>
        {preview && !expanded && (
          <p className="text-muted-foreground mt-1 truncate text-left text-sm">{preview}</p>
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-2 border-t px-3 pt-3 pb-3">
              <div>
                <span className="text-muted-foreground text-xs font-medium">Payload</span>
                <pre className="bg-muted mt-1 max-h-40 overflow-auto rounded p-2 font-mono text-xs">
                  {String(JSON.stringify(message.payload, null, 2))}
                </pre>
              </div>
              {message.budget != null && (
                <div>
                  <span className="text-muted-foreground text-xs font-medium">Budget</span>
                  <pre className="bg-muted mt-1 rounded p-2 font-mono text-xs">
                    {String(JSON.stringify(message.budget, null, 2))}
                  </pre>
                </div>
              )}

              {/* Trace toggle — only shown when message has an id */}
              {messageId && (
                <div className="border-t pt-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowTrace(!showTrace);
                    }}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
                  >
                    <Activity className="size-3.5" />
                    {showTrace ? 'Hide trace' : 'Show trace'}
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Trace section — only mounts (and fetches) when toggled */}
      <AnimatePresence initial={false}>
        {showTrace && messageId && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden border-t"
          >
            <MessageTrace messageId={messageId} onClose={() => setShowTrace(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
