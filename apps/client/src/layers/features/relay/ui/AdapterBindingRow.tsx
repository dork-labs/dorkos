import { ArrowRight } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { STRATEGY_BADGE_LABELS } from '../lib/binding-labels';

interface AdapterBindingRowProps {
  agentName: string;
  sessionStrategy: string;
  chatId?: string;
  channelType?: string;
}

/** Displays a single adapter→agent binding as a compact row with strategy and optional chat badges. */
export function AdapterBindingRow({ agentName, sessionStrategy, chatId, channelType }: AdapterBindingRowProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <ArrowRight className="size-3 shrink-0" />
      <span className="truncate">{agentName}</span>
      <Badge variant="secondary" className="shrink-0 text-xs">
        {STRATEGY_BADGE_LABELS[sessionStrategy] ?? sessionStrategy}
      </Badge>
      {chatId && (
        <Badge variant="outline" className="shrink-0 truncate text-xs">
          {channelType ? `#${chatId}` : chatId}
        </Badge>
      )}
    </div>
  );
}
