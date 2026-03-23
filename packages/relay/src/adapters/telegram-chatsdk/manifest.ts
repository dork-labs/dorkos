/**
 * Adapter manifest for the Chat SDK-backed Telegram adapter.
 *
 * @module relay/adapters/telegram-chatsdk/manifest
 */
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

/** Static adapter manifest for the Chat SDK Telegram adapter. */
export const TELEGRAM_CHATSDK_MANIFEST: AdapterManifest = {
  type: 'telegram-chatsdk',
  displayName: 'Telegram (Chat SDK)',
  description:
    'Deprecated — use the Telegram adapter instead. Lacks streaming previews, interactive approvals, typing indicators, and reconnection logic.',
  deprecated: true,
  iconId: 'telegram',
  category: 'messaging',
  docsUrl: 'https://github.com/anthropics/chat',
  builtin: true,
  multiInstance: true,
  actionButton: {
    label: 'Open @BotFather in Telegram',
    url: 'tg://resolve?domain=botfather',
  },
  setupSteps: [
    {
      stepId: 'get-token',
      title: 'Get your Bot Token',
      description: 'Create a bot with @BotFather on Telegram.',
      fields: ['token'],
    },
    {
      stepId: 'configure-mode',
      title: 'Choose connection mode',
      fields: ['mode'],
    },
  ],
  configFields: [
    {
      key: 'token',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: '123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      description: 'Paste the token from @BotFather.',
      pattern: '^\\d+:[\\w-]{35,}$',
      patternMessage: 'Expected format: 123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      visibleByDefault: true,
    },
    {
      key: 'mode',
      label: 'Receiving Mode',
      type: 'select',
      required: true,
      default: 'polling',
      options: [
        { label: 'Long Polling', value: 'polling', description: 'Works everywhere.' },
        { label: 'Webhook', value: 'webhook', description: 'Requires public HTTPS URL.' },
      ],
    },
  ],
  setupInstructions:
    'Open Telegram and search for @BotFather. Send /newbot, choose a name and username. Copy the token provided.',
};
