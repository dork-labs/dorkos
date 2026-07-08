import { useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import type { AdapterBinding, CatalogInstance } from '@dorkos/shared/relay-schemas';
import { AdapterBindingRow } from './AdapterBindingRow';
import { QuickBindingPopover } from '../QuickBindingPopover';

/** Maximum binding rows to display before showing overflow link. */
const MAX_VISIBLE_BINDINGS = 3;

interface BoundAgentRow {
  bindingId: string;
  agentName: string;
  sessionStrategy: string;
  chatId?: string;
  channelType?: string;
  canInitiate?: boolean;
  canReply?: boolean;
  canReceive?: boolean;
  /** The full binding record for this row — passed to edit rather than paired by index. */
  binding: AdapterBinding;
}

interface AdapterCardBindingsProps {
  instance: CatalogInstance;
  isBuiltinClaude: boolean;
  boundAgentRows: BoundAgentRow[];
  totalAgentCount: number;
  isConnected: boolean;
  hasBindings: boolean;
  onEditBinding: (binding: AdapterBinding) => void;
  onQuickBind: (agentId: string) => Promise<void>;
  onAdvancedBind: () => void;
  createBindingPending: boolean;
}

/** Renders the adapter card body: CCA summary, binding rows with overflow, or QuickBindingPopover. */
export function AdapterCardBindings({
  instance,
  isBuiltinClaude,
  boundAgentRows,
  totalAgentCount,
  isConnected,
  hasBindings,
  onEditBinding,
  onQuickBind,
  onAdvancedBind,
  createBindingPending,
}: AdapterCardBindingsProps) {
  const [showAllBindings, setShowAllBindings] = useState(false);

  const visibleBindings = showAllBindings
    ? boundAgentRows
    : boundAgentRows.slice(0, MAX_VISIBLE_BINDINGS);
  const overflowCount = boundAgentRows.length - MAX_VISIBLE_BINDINGS;

  return (
    <div className="mt-3 space-y-1.5 pl-[18px]">
      {isBuiltinClaude ? (
        <p className="text-muted-foreground text-sm">
          Serving {totalAgentCount} {totalAgentCount === 1 ? 'agent' : 'agents'} &middot; Chat +
          Tasks
        </p>
      ) : hasBindings ? (
        <>
          {visibleBindings.map((row) => (
            <button
              key={row.bindingId}
              type="button"
              className="group/row hover:bg-muted/50 flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors"
              onClick={() => onEditBinding(row.binding)}
            >
              <AdapterBindingRow
                agentName={row.agentName}
                sessionStrategy={row.sessionStrategy}
                chatId={row.chatId}
                channelType={row.channelType}
                canInitiate={row.canInitiate}
                canReply={row.canReply}
                canReceive={row.canReceive}
              />
              <ChevronRight className="text-muted-foreground ml-auto size-3 opacity-0 transition-opacity group-hover/row:opacity-100" />
            </button>
          ))}
          {overflowCount > 0 && !showAllBindings && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground mt-1 text-xs hover:underline"
              onClick={() => setShowAllBindings(true)}
            >
              Show {overflowCount} more
            </button>
          )}
          {showAllBindings && boundAgentRows.length > MAX_VISIBLE_BINDINGS && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground mt-1 text-xs hover:underline"
              onClick={() => setShowAllBindings(false)}
            >
              Show less
            </button>
          )}
          <QuickBindingPopover
            adapterId={instance.id}
            onQuickBind={onQuickBind}
            onAdvanced={onAdvancedBind}
            isPending={createBindingPending}
          >
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground mt-1 h-6 gap-1 px-2 text-xs"
            >
              <Plus className="size-3" />
              Add channel
            </Button>
          </QuickBindingPopover>
        </>
      ) : isConnected ? (
        <QuickBindingPopover
          adapterId={instance.id}
          onQuickBind={onQuickBind}
          onAdvanced={onAdvancedBind}
          isPending={createBindingPending}
        >
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-6 gap-1 px-2 text-xs text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:text-amber-500 dark:hover:bg-amber-950"
          >
            <Plus className="size-3" />
            Add channel
          </Button>
        </QuickBindingPopover>
      ) : null}
    </div>
  );
}
