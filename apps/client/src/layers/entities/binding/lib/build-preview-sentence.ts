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

interface BuildPreviewSentenceInput {
  sessionStrategy: SessionStrategy;
  chatDisplayName?: string;
  channelType?: string;
}

/**
 * Builds a short, human-readable description of a binding's routing behavior.
 *
 * Used on ChannelBindingCard (as the card's subtitle) and in BindingDialog
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
  if (channelType) return `${strategy} · ${channelType}`;
  return strategy;
}
