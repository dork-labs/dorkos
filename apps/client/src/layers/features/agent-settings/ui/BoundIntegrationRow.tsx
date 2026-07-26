import { useMemo } from 'react';
import { useObservedChats } from '@/layers/entities/relay';
import type { AdapterBinding, BindingTestResult } from '@dorkos/shared/relay-schemas';
import { IntegrationBindingCard, type CardAdapterState } from './IntegrationBindingCard';

interface BoundIntegrationRowProps {
  /** The binding to display. */
  binding: AdapterBinding;
  /** Display name of the integration (adapter displayName from catalog). */
  integrationName: string;
  /** Icon identifier from the adapter manifest. */
  integrationIconId?: string;
  /** Adapter type — used as icon fallback when integrationIconId is absent. */
  integrationAdapterType: string;
  /** Current adapter connection state. */
  adapterState: CardAdapterState;
  /** Error message to show when adapterState === 'error'. */
  errorMessage?: string;
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
 * Thin wrapper around IntegrationBindingCard that resolves a binding's raw chatId
 * to a human-readable display name and computes `lastMessageAt` from observed
 * chat data via useObservedChats.
 *
 * This component exists because useObservedChats must be called once per
 * binding (per adapterId). Calling hooks in a loop violates React rules, so
 * each binding row owns its own hook call.
 */
export function BoundIntegrationRow({
  binding,
  integrationName,
  integrationIconId,
  integrationAdapterType,
  adapterState,
  errorMessage,
  onTogglePause,
  onTest,
  onEdit,
  onRemove,
}: BoundIntegrationRowProps) {
  const { data: observedChats = [] } = useObservedChats(binding.adapterId);

  // Resolve chatId → displayName; fall back to #<last-4-chars> when not found.
  const chat = binding.chatId ? observedChats.find((c) => c.chatId === binding.chatId) : undefined;
  const chatDisplayName =
    chat?.displayName ?? (binding.chatId ? `#${binding.chatId.slice(-4)}` : undefined);

  // Derive lastMessageAt from observed chats. When a specific chatId is bound,
  // use that chat's timestamp; otherwise pick the most recent across all chats.
  const lastMessageAt = useMemo(() => {
    if (chat) return chat.lastMessageAt;
    if (observedChats.length === 0) return undefined;
    return observedChats.reduce(
      (latest, c) => (c.lastMessageAt > latest ? c.lastMessageAt : latest),
      observedChats[0].lastMessageAt
    );
  }, [chat, observedChats]);

  return (
    <IntegrationBindingCard
      binding={binding}
      integrationName={integrationName}
      integrationIconId={integrationIconId}
      integrationAdapterType={integrationAdapterType}
      adapterState={adapterState}
      errorMessage={errorMessage}
      chatDisplayName={chatDisplayName}
      lastMessageAt={lastMessageAt}
      onTogglePause={onTogglePause}
      onTest={onTest}
      onEdit={onEdit}
      onRemove={onRemove}
    />
  );
}
