import type { SessionStrategy } from '@dorkos/shared/relay-schemas';

/**
 * Sentinel value used for Radix Select "any / no filter selected" option.
 * Radix forbids empty-string values on SelectItem, so BindingDialog uses this
 * sentinel to detect "no filter selected".
 */
export const SELECT_ANY = '__any__';

const STRATEGY_PHRASES: Record<SessionStrategy, string> = {
  'per-chat': 'One thread for each conversation',
  'per-user': 'One thread for each person',
  stateless: 'No memory between messages',
};

/**
 * Human labels for a binding's chat-kind filter, keyed by the platform's raw
 * wire value. The bare platform-sense "channel" is qualified ("Broadcast
 * channel") so it never reads as the cockpit's conversation-sense Channels nav.
 * Wire values (dm/group/channel/thread) are unchanged — only the display label.
 */
export const CHAT_TYPE_OPTIONS: { value: 'dm' | 'group' | 'channel' | 'thread'; label: string }[] =
  [
    { value: 'dm', label: 'Direct message' },
    { value: 'group', label: 'Group' },
    { value: 'channel', label: 'Broadcast channel' },
    { value: 'thread', label: 'Thread' },
  ];

/**
 * Resolve a chat-kind wire value to its human label, falling back to the raw
 * value for kinds a platform reports that are outside the known set.
 *
 * @param value - The chat-kind wire value (e.g. `dm`, `channel`).
 */
export function chatTypeLabel(value: string): string {
  return CHAT_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

interface BuildPreviewSentenceInput {
  sessionStrategy: SessionStrategy;
  chatDisplayName?: string;
  channelType?: string;
}

/**
 * Builds a short, human-readable description of a binding's routing behavior.
 *
 * Used on IntegrationBindingCard (as the card's subtitle) and in BindingDialog
 * (as the live preview while editing).
 *
 * @param input - The binding configuration fields relevant to the preview.
 */
export function buildPreviewSentence({
  sessionStrategy,
  chatDisplayName,
  channelType,
}: BuildPreviewSentenceInput): string {
  const strategy = STRATEGY_PHRASES[sessionStrategy];
  if (chatDisplayName) return `${strategy} in ${chatDisplayName}`;
  if (channelType) return `${strategy} · ${chatTypeLabel(channelType)}`;
  return strategy;
}
