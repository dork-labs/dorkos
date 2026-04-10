import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
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
  DropdownMenuTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { AdapterIcon, ADAPTER_STATE_DOT_CLASS } from '@/layers/features/relay';
import { buildPreviewSentence } from '@/layers/features/mesh/lib/build-preview-sentence';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

/** The four states exposed by ChannelBindingCard (transient states collapsed to 'connecting'). */
export type CardAdapterState = 'connected' | 'disconnected' | 'error' | 'connecting';

/**
 * Maps the four card-level states to dot classes.
 * 'disconnected' uses amber here — a dropped channel binding warrants attention,
 * unlike the relay panel where disconnected means idle/ready (muted-foreground).
 * 'connecting' surfaces as the amber-pulsing 'starting' class — same visual meaning.
 */
const STATE_DOT_CLASS: Record<CardAdapterState, string> = {
  connected: ADAPTER_STATE_DOT_CLASS.connected,
  disconnected: 'bg-amber-500',
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

interface ChannelBindingCardProps {
  /** The binding to display. */
  binding: AdapterBinding;
  /** Display name of the channel (adapter displayName from catalog). */
  channelName: string;
  /** Icon identifier from the adapter manifest. */
  channelIconId?: string;
  /** Adapter type — used as icon fallback when channelIconId is absent. */
  channelAdapterType: string;
  /** Current adapter connection state. Transient states (starting/stopping/reconnecting) should be passed as 'connecting'. */
  adapterState: CardAdapterState;
  /** Error message to show when adapterState === 'error'. */
  errorMessage?: string;
  /** Pre-resolved display name for the binding's chatId, if any. */
  chatDisplayName?: string;
  /** Called when the user clicks Edit. */
  onEdit: () => void;
  /** Called when the user confirms removal. */
  onRemove: () => void;
}

/**
 * Card displaying a single channel binding with progressive disclosure design.
 *
 * Primary surface shows: brand icon with status-dot overlay, channel name,
 * optional chat display name, preview sentence (or error), Restricted pill
 * when permissions deviate from defaults, and an always-visible kebab menu.
 *
 * Raw jargon (sessionStrategy, chatId, per-permission icons) is never shown
 * on this card — those details live in the edit dialog.
 */
export function ChannelBindingCard({
  binding,
  channelName,
  channelIconId,
  channelAdapterType,
  adapterState,
  errorMessage,
  chatDisplayName,
  onEdit,
  onRemove,
}: ChannelBindingCardProps) {
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  // Concatenate channel name + chat display name with an em-dash when present.
  const primaryText = chatDisplayName ? `${channelName} — ${chatDisplayName}` : channelName;

  const previewSentence = buildPreviewSentence({
    sessionStrategy: binding.sessionStrategy,
    chatDisplayName,
    channelType: binding.channelType,
  });

  // Show the Restricted pill when any permission deviates from its default.
  const isRestricted = binding.canInitiate || !binding.canReply || !binding.canReceive;
  const restrictionDetail = isRestricted ? buildRestrictionDetail(binding) : '';

  return (
    <div
      className={cn(
        'relative rounded-xl border px-4 py-3 transition-colors',
        adapterState === 'error' && 'border-red-500/50 bg-red-500/[0.02]'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Brand icon with status-dot overlay */}
        <div className="relative shrink-0">
          <AdapterIcon iconId={channelIconId} adapterType={channelAdapterType} size={32} />
          <span
            className={cn(
              'ring-background absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2',
              STATE_DOT_CLASS[adapterState]
            )}
          />
        </div>

        {/* Text content */}
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium">{primaryText}</span>
          {adapterState === 'error' && errorMessage ? (
            <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
          ) : previewSentence ? (
            <p className="text-muted-foreground truncate text-xs italic">{previewSentence}</p>
          ) : null}
        </div>

        {/* Restricted pill — shown only when permissions deviate from defaults */}
        {isRestricted && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-xs">
                Restricted
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{restrictionDetail}</TooltipContent>
          </Tooltip>
        )}

        {/* Always-visible kebab menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
            <AlertDialogTitle>Remove channel binding</AlertDialogTitle>
            <AlertDialogDescription>
              Remove the binding to {channelName}? The agent will no longer receive messages from
              this channel.
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
