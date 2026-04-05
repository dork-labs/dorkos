import { useState } from 'react';
import { Zap, MessageSquareOff, BellOff } from 'lucide-react';
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
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

interface ChannelBindingCardProps {
  /** The binding to display. */
  binding: AdapterBinding;
  /** Display name of the channel (adapter displayName from catalog). */
  channelName: string;
  /** Current adapter connection state. */
  adapterState: 'connected' | 'disconnected' | 'error';
  /** Whether the adapter has an error message to show. */
  errorMessage?: string;
  /** Called when the user clicks Edit. */
  onEdit: () => void;
  /** Called when the user confirms removal. */
  onRemove: () => void;
}

/**
 * Card displaying a single channel binding with status dot, name, strategy badge,
 * chat filter, permission icons, hover actions, error state, and remove confirmation.
 */
export function ChannelBindingCard({
  binding,
  channelName,
  adapterState,
  errorMessage,
  onEdit,
  onRemove,
}: ChannelBindingCardProps) {
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  return (
    <div
      className={cn(
        'group relative rounded-lg border px-3 py-2.5 transition-colors',
        adapterState === 'error' && 'border-red-500/50'
      )}
    >
      <div className="flex items-center gap-3">
        {/* Status dot */}
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            adapterState === 'connected' && 'bg-green-500',
            adapterState === 'disconnected' && 'bg-amber-500',
            adapterState === 'error' && 'bg-red-500'
          )}
        />

        {/* Channel name */}
        <span className="text-sm font-medium">{channelName}</span>

        {/* Strategy badge */}
        <Badge variant="outline" className="text-xs">
          {binding.sessionStrategy}
        </Badge>

        {/* Chat filter badge (optional) */}
        {binding.chatId && (
          <Badge variant="secondary" className="text-xs">
            {binding.chatId}
          </Badge>
        )}

        {/* Permission icons */}
        <div className="ml-auto flex items-center gap-1">
          {binding.canInitiate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Zap className="text-muted-foreground size-3" />
              </TooltipTrigger>
              <TooltipContent>Can initiate conversations</TooltipContent>
            </Tooltip>
          )}
          {!binding.canReply && (
            <Tooltip>
              <TooltipTrigger asChild>
                <MessageSquareOff className="text-muted-foreground/50 size-3" />
              </TooltipTrigger>
              <TooltipContent>Cannot reply</TooltipContent>
            </Tooltip>
          )}
          {!binding.canReceive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <BellOff className="text-muted-foreground/50 size-3" />
              </TooltipTrigger>
              <TooltipContent>Cannot receive</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Hover actions */}
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive h-7 px-2 text-xs"
            onClick={() => setShowRemoveConfirm(true)}
          >
            Remove
          </Button>
        </div>
      </div>

      {/* Error detail */}
      {adapterState === 'error' && errorMessage && (
        <p className="mt-1.5 text-xs text-red-500">{errorMessage}</p>
      )}

      {/* Remove confirmation */}
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
