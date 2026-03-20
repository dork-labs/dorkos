import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui/tooltip';
import { STRATEGY_BADGE_LABELS } from '../lib/binding-labels';

interface AdapterBindingRowProps {
  agentName: string;
  sessionStrategy: string;
  chatId?: string;
  channelType?: string;
  /** Whether the agent can initiate messages unprompted. Non-default (true) shows a shield indicator. */
  canInitiate?: boolean;
  /** Whether the agent can reply to inbound messages. Non-default (false) shows a badge. */
  canReply?: boolean;
  /** Whether inbound messages are delivered to the agent. Non-default (false) shows a badge. */
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
      <ArrowRight className="size-3 shrink-0" />
      <span className="truncate">{agentName}</span>

      {/* Session strategy badge — hidden when default (per-chat) */}
      {sessionStrategy !== 'per-chat' && (
        <Badge variant="secondary" className="shrink-0 text-xs">
          {STRATEGY_BADGE_LABELS[sessionStrategy] ?? sessionStrategy}
        </Badge>
      )}

      {chatId && (
        <Badge variant="outline" className="shrink-0 truncate text-xs">
          {channelType ? `#${chatId}` : chatId}
        </Badge>
      )}

      {/* Permission indicators — only shown for non-default values */}
      {canInitiate && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <ShieldCheck
                className="size-3 shrink-0 text-amber-500"
                aria-label="Can initiate messages"
              />
            </TooltipTrigger>
            <TooltipContent>Can initiate messages</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {!canReply && (
        <Badge variant="outline" className="text-muted-foreground shrink-0 text-[10px]">
          Reply disabled
        </Badge>
      )}
      {!canReceive && (
        <Badge variant="outline" className="text-muted-foreground shrink-0 text-[10px]">
          Receive disabled
        </Badge>
      )}
    </div>
  );
}
