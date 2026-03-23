/**
 * Adapter brand logo components and registry map.
 *
 * Telegram, Slack, and Anthropic/Claude are trademarks of their respective owners.
 * Logos are used to identify connected services and do not imply endorsement.
 * SVG paths sourced from Simple Icons (CC0 license) unless noted otherwise.
 *
 * @module icons/adapter-logos
 */
import { Webhook, Bot } from 'lucide-react';

/** Shared props for all adapter logo components. */
export interface AdapterLogoProps {
  /** Icon size in pixels. */
  size?: number;
  className?: string;
}

/** Telegram paper-plane mark (Simple Icons, CC0). */
export function TelegramLogo({ size = 16, className }: AdapterLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

/** Anthropic logo mark (Simple Icons, CC0). Used for Claude Code adapter. */
export function AnthropicLogo({ size = 16, className }: AdapterLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M17.304 3.541h-3.672l6.696 16.918h3.672zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541zm-.372 10.339 2.18-5.632 2.171 5.632z" />
    </svg>
  );
}

/** Webhook icon — reuses Lucide's built-in Webhook component. */
export function WebhookIcon({ size = 16, className }: AdapterLogoProps) {
  return <Webhook className={className} style={{ width: size, height: size }} />;
}

/**
 * Slack icon — styled `#` character in Slack purple.
 *
 * Slack Brand Terms of Service prohibit logo use without Marketplace listing.
 * This stylized hash mark is instantly recognizable without violating ToS.
 */
export function SlackIcon({ size = 16, className }: AdapterLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <text
        x="12"
        y="18"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="20"
        fontWeight="900"
        fill="currentColor"
      >
        #
      </text>
    </svg>
  );
}

/** Fallback icon for unknown adapter types. */
export function DefaultAdapterIcon({ size = 16, className }: AdapterLogoProps) {
  return <Bot className={className} style={{ width: size, height: size }} />;
}

/**
 * Maps adapter type identifiers to their logo components.
 *
 * Keys match the `iconId` field on `AdapterManifest` (which in turn matches
 * the adapter's `type` for built-in adapters).
 */
export const ADAPTER_LOGO_MAP: Record<string, React.ComponentType<AdapterLogoProps>> = {
  telegram: TelegramLogo,
  'telegram-chatsdk': TelegramLogo,
  'claude-code': AnthropicLogo,
  slack: SlackIcon,
  webhook: WebhookIcon,
};
