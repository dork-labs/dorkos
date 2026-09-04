import { useState, useEffect, useMemo } from 'react';
import { FlaskConical, Loader2, MoreHorizontal, Pause, Play } from 'lucide-react';
import {
  Badge,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/layers/shared/ui';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { AdapterIcon, ADAPTER_STATE_DOT_CLASS } from '@/layers/features/relay';
import { STATUS_TONE_DOT } from '@/layers/shared/ui';
import { buildPreviewSentence } from '@/layers/entities/binding';
import type { AdapterBinding, BindingTestResult } from '@dorkos/shared/relay-schemas';

/** The four states exposed by IntegrationBindingCard (transient states collapsed to 'connecting'). */
export type CardAdapterState = 'connected' | 'disconnected' | 'error' | 'connecting';

/**
 * Maps the four card-level states to dot classes.
 * 'disconnected' spends the plain `warning` tone here — a dropped integration
 * binding warrants attention, unlike the relay panel where disconnected means
 * idle/ready (`neutral`). It reads `STATUS_TONE_DOT` directly rather than
 * `ADAPTER_STATE_DOT_CLASS.starting`, which pairs the same amber with the
 * pulse animation `connecting` below wears — disconnected is a held state,
 * not a transition, so it stays still.
 * 'connecting' surfaces as the amber-pulsing 'starting' class — same visual meaning.
 */
const STATE_DOT_CLASS: Record<CardAdapterState, string> = {
  connected: ADAPTER_STATE_DOT_CLASS.connected,
  disconnected: STATUS_TONE_DOT.warning,
  error: ADAPTER_STATE_DOT_CLASS.error,
  connecting: ADAPTER_STATE_DOT_CLASS.starting,
};

/**
 * Returns a human-readable summary of non-default permissions for the tooltip.
 * Empty string when no permissions deviate from defaults.
 */
function buildRestrictionDetail(binding: AdapterBinding): string {
  const parts: string[] = [];
  if (binding.canInitiate) parts.push('Can start conversations');
  if (!binding.canReply) parts.push('Cannot reply');
  if (!binding.canReceive) parts.push('Cannot receive');
  return parts.join(' · ');
}

interface IntegrationBindingCardProps {
  /** The binding to display. */
  binding: AdapterBinding;
  /** Display name of the integration (adapter displayName from catalog). */
  integrationName: string;
  /** Icon identifier from the adapter manifest. */
  integrationIconId?: string;
  /** Adapter type — used as icon fallback when integrationIconId is absent. */
  integrationAdapterType: string;
  /** Current adapter connection state. Transient states (starting/stopping/reconnecting) should be passed as 'connecting'. */
  adapterState: CardAdapterState;
  /** Error message to show when adapterState === 'error'. */
  errorMessage?: string;
  /** Pre-resolved display name for the binding's chatId, if any. */
  chatDisplayName?: string;
  /** ISO timestamp of the last observed inbound message for this binding's adapter instance. */
  lastMessageAt?: string;
  /** Called when the user toggles pause/resume. */
  onTogglePause: (enabled: boolean) => void;
  /** Called when the user runs a test. Returns a promise for the UI to await. */
  onTest: () => Promise<BindingTestResult>;
  /** Called when the user clicks Edit. */
  onEdit: () => void;
  /** Called when the user confirms removal. */
  onRemove: () => void;
}

/**
 * Card displaying a single integration binding with progressive disclosure design.
 *
 * Primary surface shows: brand icon with status-dot overlay, integration name,
 * optional chat display name, preview sentence (or error), Restricted pill
 * when permissions deviate from defaults, and an always-visible kebab menu.
 *
 * Raw jargon (sessionStrategy, chatId, per-permission icons) is never shown
 * on this card — those details live in the edit dialog.
 */
export function IntegrationBindingCard({
  binding,
  integrationName,
  integrationIconId,
  integrationAdapterType,
  adapterState,
  errorMessage,
  chatDisplayName,
  lastMessageAt,
  onTogglePause,
  onTest,
  onEdit,
  onRemove,
}: IntegrationBindingCardProps) {
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [isTestPending, setIsTestPending] = useState(false);

  const isPaused = binding.enabled === false;

  // Force re-render every 60s so the relative time label stays fresh.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!lastMessageAt || isPaused) return;
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, [lastMessageAt, isPaused]);

  // Concatenate integration name + chat display name with an em-dash when present.
  const primaryText = chatDisplayName ? `${integrationName} — ${chatDisplayName}` : integrationName;

  const previewSentence = buildPreviewSentence({
    sessionStrategy: binding.sessionStrategy,
    chatDisplayName,
    channelType: binding.channelType,
  });

  // Show the Restricted pill when any permission deviates from its default.
  const isRestricted = binding.canInitiate || !binding.canReply || !binding.canReceive;
  const restrictionDetail = isRestricted ? buildRestrictionDetail(binding) : '';

  const activityText = useMemo(() => {
    if (isPaused) return 'Paused \u2014 no messages routing';
    if (!lastMessageAt) return 'No recent activity';
    return `Last received ${formatRelativeTime(lastMessageAt).toLowerCase()}`;
    // `tick` is intentionally read as a dep so the label recomputes on the 60s interval.
  }, [isPaused, lastMessageAt, tick]);

  const handleTest = async () => {
    setIsTestPending(true);
    try {
      await onTest();
    } finally {
      setIsTestPending(false);
    }
  };

  return (
    <div
      className={cn(
        'relative rounded-xl border px-4 py-3 transition-colors',
        adapterState === 'error' && !isPaused && 'border-red-500/50 bg-red-500/[0.02]',
        isPaused && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Brand icon with status-dot overlay */}
        <div className="relative shrink-0">
          <AdapterIcon iconId={integrationIconId} adapterType={integrationAdapterType} size={32} />
          <span
            className={cn(
              'ring-background absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2',
              isPaused ? 'bg-muted-foreground/40' : STATE_DOT_CLASS[adapterState]
            )}
          />
        </div>

        {/* Text content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{primaryText}</span>
            {isPaused && <Badge variant="secondary">Paused</Badge>}
          </div>
          {isPaused ? (
            <p className="text-muted-foreground mt-1 text-xs">{activityText}</p>
          ) : adapterState === 'error' && errorMessage ? (
            <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
          ) : (
            <>
              {previewSentence && (
                <p className="text-muted-foreground truncate text-xs italic">{previewSentence}</p>
              )}
              <p className="text-muted-foreground mt-1 text-xs">{activityText}</p>
            </>
          )}
        </div>

        {/* Restricted pill — shown only when permissions deviate from defaults */}
        {isRestricted && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline">Restricted</Badge>
            </TooltipTrigger>
            <TooltipContent>{restrictionDetail}</TooltipContent>
          </Tooltip>
        )}

        {/* Always-visible kebab menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" responsive={false} className="h-8 w-8 shrink-0">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleTest} disabled={isTestPending || isPaused}>
              {isTestPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <FlaskConical className="mr-2 size-4" />
              )}
              Send test
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onTogglePause(!binding.enabled)}>
              {isPaused ? (
                <>
                  <Play className="mr-2 size-4" />
                  Resume
                </>
              ) : (
                <>
                  <Pause className="mr-2 size-4" />
                  Pause
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setShowRemoveConfirm(true)}
              className="text-destructive focus:text-destructive"
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Remove confirmation dialog */}
      <AlertDialog open={showRemoveConfirm} onOpenChange={setShowRemoveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove connection</AlertDialogTitle>
            <AlertDialogDescription>
              Remove the connection to {integrationName}? The agent will no longer receive messages
              from it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onRemove();
                setShowRemoveConfirm(false);
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
