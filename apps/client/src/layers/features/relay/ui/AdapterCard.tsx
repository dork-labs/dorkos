import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, ChevronRight, MoreVertical, Settings, Trash2 } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { Button } from '@/layers/shared/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui/collapsible';
import { Switch } from '@/layers/shared/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/layers/shared/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/layers/shared/ui/alert-dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/layers/shared/ui/sheet';
import { cn } from '@/layers/shared/lib';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';
import { useBindings } from '@/layers/entities/binding';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { getCategoryColorClasses } from '../lib/category-colors';
import { AdapterEventLog } from './AdapterEventLog';
import { AdapterBindingRow } from './AdapterBindingRow';

/** Maximum binding rows to display before showing overflow link. */
const MAX_VISIBLE_BINDINGS = 3;

interface AdapterCardProps {
  instance: CatalogInstance;
  manifest: AdapterManifest;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
  onRemove: () => void;
  /** Optional callback invoked when the user clicks "Bind" in the no-bindings amber state. */
  onBindClick?: () => void;
}

/** Displays a configured adapter instance with status, toggle, and kebab menu actions. */
export function AdapterCard({ instance, manifest, onToggle, onConfigure, onRemove, onBindClick }: AdapterCardProps) {
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [eventsSheetOpen, setEventsSheetOpen] = useState(false);
  const isBuiltinClaude = manifest.type === 'claude-code' && manifest.builtin;

  // Prefer custom label as primary display name, fall back to status displayName or id.
  const primaryName = instance.label || instance.status.displayName || instance.id;
  // When a custom label exists, show the manifest type name as secondary context.
  const secondaryName = instance.label ? (instance.status.displayName || manifest.displayName) : null;

  const { data: allBindings = [] } = useBindings();
  const { data: agentsData } = useRegisteredAgents();

  const agents = agentsData?.agents ?? [];
  const totalAgentCount = agents.length;

  const adapterBindings = useMemo(
    () => allBindings.filter((b) => b.adapterId === instance.id),
    [allBindings, instance.id],
  );

  const boundAgentRows = useMemo(() => {
    return adapterBindings.map((b) => {
      const agent = agents.find((a) => a.id === b.agentId);
      return {
        bindingId: b.id,
        agentName: agent?.name ?? b.agentId,
        sessionStrategy: b.sessionStrategy,
        chatId: b.chatId,
        channelType: b.channelType,
      };
    });
  }, [adapterBindings, agents]);

  const hasBindings = adapterBindings.length > 0;
  const isConnected = instance.status.state === 'connected';
  // CCA is always considered "bound" — it serves all agents
  const effectiveHasBindings = isBuiltinClaude || hasBindings;

  // Status dot color: green when connected + bound, amber when connected + unbound,
  // red for errors, pulsing blue for transitional states, gray otherwise.
  const statusDotClass = cn(
    'size-2 shrink-0 rounded-full',
    instance.status.state === 'error' && 'bg-red-500',
    instance.status.state === 'connected' && effectiveHasBindings && 'bg-green-500',
    instance.status.state === 'connected' && !effectiveHasBindings && 'animate-pulse bg-amber-500',
    instance.status.state === 'disconnected' && 'bg-gray-400',
    instance.status.state === 'starting' && 'animate-pulse bg-blue-400',
    instance.status.state === 'stopping' && 'animate-pulse bg-gray-400',
    !['error', 'connected', 'disconnected', 'starting', 'stopping'].includes(instance.status.state) && 'bg-gray-400',
  );

  const visibleBindings = boundAgentRows.slice(0, MAX_VISIBLE_BINDINGS);
  const overflowCount = boundAgentRows.length - MAX_VISIBLE_BINDINGS;

  return (
    <>
      <div
        className={cn(
          'rounded-xl border p-5 shadow-soft transition-shadow hover:shadow-elevated',
          isBuiltinClaude && 'border-dashed',
        )}
      >
        {/* Header: status dot, emoji, name, toggle, kebab */}
        <div className="flex items-start justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className={statusDotClass} aria-hidden />
            {manifest.iconEmoji && (
              <span className="text-sm" role="img" aria-hidden>
                {manifest.iconEmoji}
              </span>
            )}
            <span className="text-sm font-medium">{primaryName}</span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Switch checked={instance.enabled} onCheckedChange={onToggle} />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="size-7 p-0" aria-label="Adapter actions">
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setEventsSheetOpen(true)}>
                  <Activity className="mr-2 size-3.5" />
                  Events
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onConfigure}>
                  <Settings className="mr-2 size-3.5" />
                  Configure
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setRemoveDialogOpen(true)}
                  disabled={isBuiltinClaude}
                  className="text-red-600 focus:text-red-600"
                >
                  <Trash2 className="mr-2 size-3.5" />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Subtitle: adapter type + category */}
        <div className="mt-1 flex items-center gap-2 pl-[18px]">
          {secondaryName && (
            <span className="text-xs text-muted-foreground">{secondaryName}</span>
          )}
          {secondaryName && <span className="text-xs text-muted-foreground/50">&middot;</span>}
          <Badge variant="secondary" className={cn('text-xs', getCategoryColorClasses(manifest.category))}>
            {manifest.category}
          </Badge>
        </div>

        {/* Body: bindings or CCA summary */}
        <div className="mt-3 space-y-1.5 pl-[18px]">
          {isBuiltinClaude ? (
            <p className="text-sm text-muted-foreground">
              Serving {totalAgentCount} {totalAgentCount === 1 ? 'agent' : 'agents'} &middot; Chat + Pulse
            </p>
          ) : hasBindings ? (
            <>
              {visibleBindings.map((row) => (
                <AdapterBindingRow
                  key={row.bindingId}
                  agentName={row.agentName}
                  sessionStrategy={row.sessionStrategy}
                  chatId={row.chatId}
                  channelType={row.channelType}
                />
              ))}
              {overflowCount > 0 && (
                <button
                  onClick={onBindClick}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  and {overflowCount} more
                </button>
              )}
            </>
          ) : isConnected ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-amber-600">No agent bound</span>
              {onBindClick && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-xs"
                  onClick={onBindClick}
                >
                  Bind
                </Button>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer: error indicator only */}
        {(instance.status.errorCount > 0 || instance.status.lastError) && (
          <div className="mt-3 pl-[18px]">
            {instance.status.errorCount > 0 && !instance.status.lastError && (
              <div className="flex items-center gap-1 text-xs text-red-500">
                <AlertTriangle className="size-3" />
                <span>{instance.status.errorCount} {instance.status.errorCount === 1 ? 'error' : 'errors'}</span>
              </div>
            )}
            {instance.status.lastError && (
              <Collapsible>
                <div className="flex items-center gap-1">
                  <CollapsibleTrigger asChild>
                    <button
                      className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600"
                      aria-label="Toggle full error message"
                    >
                      <ChevronRight className="size-3 transition-transform data-[state=open]:rotate-90" />
                      {instance.status.errorCount > 0 && (
                        <AlertTriangle className="size-3" />
                      )}
                      <span className="max-w-[200px] truncate">
                        {instance.status.errorCount > 0
                          ? `${instance.status.errorCount} ${instance.status.errorCount === 1 ? 'error' : 'errors'}`
                          : instance.status.lastError}
                      </span>
                    </button>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent>
                  <div className="mt-1 rounded-md bg-red-50 p-2 font-mono text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                    {instance.status.lastError}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove adapter</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove &quot;{primaryName}&quot;? This will stop the adapter
              and remove its configuration. Messages to its subjects will no longer be delivered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onRemove}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={eventsSheetOpen} onOpenChange={setEventsSheetOpen}>
        <SheetContent className="flex flex-col sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Events: {primaryName}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden">
            <AdapterEventLog adapterId={instance.id} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
