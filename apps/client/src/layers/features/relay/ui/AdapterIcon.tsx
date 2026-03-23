/**
 * Resolves an adapter's iconId to the corresponding brand logo component.
 *
 * Centralizes icon lookup with a `Bot` Lucide fallback for unknown types.
 *
 * @module features/relay/ui/AdapterIcon
 */
import { ADAPTER_LOGO_MAP, type AdapterLogoProps } from '@dorkos/icons/adapter-logos';
import { Bot } from 'lucide-react';

interface AdapterIconProps extends AdapterLogoProps {
  /** Adapter icon identifier from the manifest. */
  iconId?: string;
  /** Adapter type — used as fallback lookup key when iconId is absent. */
  adapterType?: string;
}

/** Resolves an adapter's iconId to the correct brand logo component. */
export function AdapterIcon({ iconId, adapterType, size = 16, className }: AdapterIconProps) {
  const Logo = ADAPTER_LOGO_MAP[iconId ?? ''] ?? ADAPTER_LOGO_MAP[adapterType ?? ''];
  if (Logo) return <Logo size={size} className={className} />;
  return <Bot className={className} style={{ width: size, height: size }} />;
}
