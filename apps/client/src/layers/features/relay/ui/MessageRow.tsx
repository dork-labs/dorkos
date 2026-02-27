import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Clock, Check, AlertTriangle, MailX, Activity } from 'lucide-react';
import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { MessageTrace } from './MessageTrace';
import { getStatusBorderColor } from '../lib/status-colors';

interface MessageRowProps {
  message: Record<string, unknown>;
}

const STATUS_CONFIG: Record<string, { icon: React.ElementType; className: string; label: string }> = {
  new: { icon: Clock, className: 'text-muted-foreground', label: 'New' },
  cur: { icon: Check, className: 'text-muted-foreground', label: 'Delivered' },
  failed: { icon: AlertTriangle, className: 'text-destructive', label: 'Failed' },
  dead_letter: { icon: MailX, className: 'text-amber-500', label: 'Dead Letter' },
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

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

  const borderColor = getStatusBorderColor(
    status === 'cur' ? 'delivered' : status,
  );

  const preview = extractPreview(message.payload);

  return (
    <div
      className={cn(
        'w-full rounded-lg border border-l-2 text-left transition-colors hover:bg-muted/50 hover:shadow-sm',
        borderColor,
        expanded && 'bg-muted/30',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full p-3"
      >
        <div className="flex items-center gap-2">
          <StatusIcon className={cn('size-4 shrink-0', config.className)} />
          <span className="min-w-0 flex-1 truncate font-mono text-sm">
            {message.subject as string}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {message.from as string}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {message.createdAt ? formatTimeAgo(message.createdAt as string) : ''}
          </span>
          <Badge variant="outline" className="shrink-0 text-xs">
            {config.label}
          </Badge>
        </div>
        {preview && !expanded && (
          <p className="mt-1 truncate text-left text-sm text-muted-foreground">
            {preview}
          </p>
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
            <div className="space-y-2 border-t px-3 pb-3 pt-3">
              <div>
                <span className="text-xs font-medium text-muted-foreground">Payload</span>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs">
                  {String(JSON.stringify(message.payload, null, 2))}
                </pre>
              </div>
              {message.budget != null && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Budget</span>
                  <pre className="mt-1 rounded bg-muted p-2 font-mono text-xs">
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
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
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
