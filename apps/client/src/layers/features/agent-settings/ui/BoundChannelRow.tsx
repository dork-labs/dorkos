import { useObservedChats } from '@/layers/entities/relay';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { ChannelBindingCard, type CardAdapterState } from './ChannelBindingCard';

interface BoundChannelRowProps {
  /** The binding to display. */
  binding: AdapterBinding;
  /** Display name of the channel (adapter displayName from catalog). */
  channelName: string;
  /** Icon identifier from the adapter manifest. */
  channelIconId?: string;
  /** Adapter type — used as icon fallback when channelIconId is absent. */
  channelAdapterType: string;
  /** Current adapter connection state. */
  adapterState: CardAdapterState;
  /** Error message to show when adapterState === 'error'. */
  errorMessage?: string;
  /** Called when the user clicks Edit. */
  onEdit: () => void;
  /** Called when the user confirms removal. */
  onRemove: () => void;
}

/**
 * Thin wrapper around ChannelBindingCard that resolves a binding's raw chatId
 * to a human-readable display name via useObservedChats.
 *
 * This component exists because useObservedChats must be called once per
 * binding (per adapterId). Calling hooks in a loop violates React rules, so
 * each binding row owns its own hook call.
 */
export function BoundChannelRow({
  binding,
  channelName,
  channelIconId,
  channelAdapterType,
  adapterState,
  errorMessage,
  onEdit,
  onRemove,
}: BoundChannelRowProps) {
  const { data: observedChats = [] } = useObservedChats(binding.adapterId);

  // Resolve chatId → displayName; fall back to #<last-4-chars> when not found.
  const chat = binding.chatId ? observedChats.find((c) => c.chatId === binding.chatId) : undefined;
  const chatDisplayName =
    chat?.displayName ?? (binding.chatId ? `#${binding.chatId.slice(-4)}` : undefined);

  return (
    <ChannelBindingCard
      binding={binding}
      channelName={channelName}
      channelIconId={channelIconId}
      channelAdapterType={channelAdapterType}
      adapterState={adapterState}
      errorMessage={errorMessage}
      chatDisplayName={chatDisplayName}
      onEdit={onEdit}
      onRemove={onRemove}
    />
  );
}
