import { BellOff, MessageSquareOff, Zap } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui/tooltip';
import { sessionStrategyLabel } from '@/layers/entities/binding';

interface AdapterBindingRowProps {
  agentName: string;
  sessionStrategy: string;
  chatId?: string;
  channelType?: string;
  /** Whether the agent can initiate messages unprompted. Non-default (true) shows a zap indicator. */
  canInitiate?: boolean;
  /** Whether the agent can reply to inbound messages. Non-default (false) shows an icon. */
  canReply?: boolean;
  /** Whether inbound messages are delivered to the agent. Non-default (false) shows an icon. */
  canReceive?: boolean;
}

/** Displays a single adapter→agent binding as a compact row with strategy, chat, and permission indicators. */
export function AdapterBindingRow({
  agentName,
  sessionStrategy,
  chatId,
  channelType,
  canInitiate = false,
  canReply = true,
  canReceive = true,
}: AdapterBindingRowProps) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      <span className="truncate">{agentName}</span>

      {/* Session strategy badge — hidden when default (per-chat) */}
      {sessionStrategy !== 'per-chat' && (
        <Badge variant="secondary" className="shrink-0 text-xs">
          {sessionStrategyLabel(sessionStrategy)}
        </Badge>
      )}

      {chatId && (
        <Badge variant="outline" className="shrink-0 truncate text-xs">
          {channelType ? `#${chatId}` : chatId}
        </Badge>
      )}

      {/* Permission indicators — icon + tooltip for all non-default values */}
      <TooltipProvider>
        {canInitiate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Zap className="size-3 shrink-0 text-amber-500" aria-label="Can initiate messages" />
            </TooltipTrigger>
            <TooltipContent>Can initiate messages</TooltipContent>
          </Tooltip>
        )}
        {!canReply && (
          <Tooltip>
            <TooltipTrigger asChild>
              <MessageSquareOff
                className="text-muted-foreground/70 size-3 shrink-0"
                aria-label="Reply disabled"
              />
            </TooltipTrigger>
            <TooltipContent>Reply disabled</TooltipContent>
          </Tooltip>
        )}
        {!canReceive && (
          <Tooltip>
            <TooltipTrigger asChild>
              <BellOff
                className="text-muted-foreground/70 size-3 shrink-0"
                aria-label="Receive disabled"
              />
            </TooltipTrigger>
            <TooltipContent>Receive disabled</TooltipContent>
          </Tooltip>
        )}
      </TooltipProvider>
    </div>
  );
}
