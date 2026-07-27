/**
 * Static adapter manifest and configuration constants for the Slack adapter.
 *
 * @module relay/adapters/slack/slack-manifest
 */
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

/**
 * Slack API error codes that indicate permanent auth/permission failures.
 *
 * When one of these is returned, retrying is futile — the bot token is invalid,
 * revoked, or lacks required scopes. The adapter should stop immediately to
 * prevent a retry loop.
 */
export const FATAL_SLACK_ERRORS = new Set([
  'account_inactive',
  'invalid_auth',
  'token_revoked',
  'not_authed',
  'missing_scope',
  'team_access_not_granted',
  'app_uninstalled',
]);

/**
 * Slack App Manifest YAML for one-click app creation.
 *
 * Pre-fills Socket Mode, bot events, and OAuth scopes so users
 * don't need to manually configure each setting.
 *
 * CRITICAL: Do NOT include `user` scopes. The "Agents & AI Apps" feature
 * in Slack silently adds user-level scopes that cause `invalid_scope`
 * errors on most workspace plans.
 */
const SLACK_APP_MANIFEST_YAML = `display_information:
  name: DorkOS Relay
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: DorkOS Relay
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false`;

/** Slack's app creation URL with pre-filled manifest for one-click setup. */
const SLACK_CREATE_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(SLACK_APP_MANIFEST_YAML)}`;

/** Static adapter manifest for the Slack built-in adapter. */
export const SLACK_MANIFEST: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Send and receive messages in Slack channels and DMs.',
  iconId: 'slack',
  category: 'messaging',
  docsUrl: 'https://api.slack.com/start',
  builtin: true,
  multiInstance: true,
  actionButton: {
    label: 'Create Slack App',
    url: SLACK_CREATE_APP_URL,
  },
  setupSteps: [
    {
      stepId: 'create-app',
      title: 'Create & Configure a Slack App',
      description:
        'Go to api.slack.com/apps \u2192 Create New App \u2192 From Scratch.\n\n' +
        '1. **Socket Mode** \u2014 Enable it (Settings \u2192 Socket Mode).\n' +
        '2. **Event Subscriptions** \u2014 Turn on Enable Events, then subscribe to bot events: app_mention, message.channels, message.groups, message.im, message.mpim.\n' +
        '3. **OAuth & Permissions** \u2014 Add bot token scopes: app_mentions:read, channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, im:write, mpim:history, reactions:read, reactions:write, users:read. Then install the app to your workspace.\n' +
        '4. **App-Level Token** \u2014 In Basic Information \u2192 App-Level Tokens, generate a token with the connections:write scope.\n\n' +
        '\u26a0\ufe0f Do NOT enable "Agents & AI Apps" \u2014 it adds user scopes that cause install failures on most workspaces.',
      fields: [
        'botToken',
        'appToken',
        'signingSecret',
        'streaming',
        'nativeStreaming',
        'typingIndicator',
      ],
    },
  ],
  configFields: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: 'xoxb-...',
      description: 'Bot User OAuth Token from OAuth & Permissions page.',
      pattern: '^xoxb-',
      patternMessage: 'Bot tokens start with xoxb-',
      visibleByDefault: true,
      helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **OAuth & Permissions** in the sidebar
4. Copy the **Bot User OAuth Token** (starts with \`xoxb-\`)`,
    },
    {
      key: 'appToken',
      label: 'App-Level Token',
      type: 'password',
      required: true,
      placeholder: 'xapp-...',
      description:
        'App-Level Token with connections:write scope. Generate in Basic Information \u2192 App-Level Tokens.',
      pattern: '^xapp-',
      patternMessage: 'App tokens start with xapp-',
      visibleByDefault: true,
      helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **Basic Information** in the sidebar
4. Scroll to **App-Level Tokens**
5. Click **Generate Token and Scopes**
6. Add the \`connections:write\` scope
7. Click **Generate** and copy the token (starts with \`xapp-\`)`,
    },
    {
      key: 'signingSecret',
      label: 'Signing Secret',
      type: 'password',
      required: true,
      placeholder: 'abc123...',
      description: 'Signing Secret from Basic Information page. Used to verify requests.',
      helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **Basic Information** in the sidebar
4. Scroll to **App Credentials**
5. Click **Show** next to **Signing Secret** and copy it`,
    },
    {
      key: 'streaming',
      label: 'Stream Responses',
      type: 'boolean',
      required: false,
      description:
        'Show responses as they arrive (live editing). Disable to send a single message when complete.',
      visibleByDefault: true,
      helpMarkdown:
        'When enabled, agent responses appear token-by-token in Slack via message editing. ' +
        'When disabled, the full response is sent as a single message after the agent finishes.',
    },
    {
      key: 'nativeStreaming',
      label: 'Native Streaming',
      type: 'boolean',
      required: false,
      description:
        "Use Slack's native streaming API (chat.startStream/appendStream/stopStream). Requires messages in threads.",
      visibleByDefault: true,
      helpMarkdown:
        "When enabled, uses Slack's purpose-built streaming API for smoother, flicker-free responses. " +
        'When disabled, uses the legacy chat.update approach. Only applies when Stream Responses is enabled.',
    },
    {
      key: 'typingIndicator',
      label: 'Typing Indicator',
      type: 'select',
      required: false,
      description: 'Show a visual indicator while the agent is working. Enabled by default.',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Emoji reaction', value: 'reaction' },
      ],
      visibleByDefault: true,
      helpMarkdown:
        'When set to "Emoji reaction", adds an :hourglass_flowing_sand: reaction to your message ' +
        'while the agent is processing. Requires the `reactions:write` and `reactions:read` scopes.',
    },
    {
      key: 'respondMode',
      label: 'Respond Mode',
      type: 'select',
      required: false,
      description: 'When should the bot respond in channels?',
      section: 'Access Control',
      options: [
        {
          label: 'Thread-aware',
          value: 'thread-aware',
          description: 'Respond to @mentions and continue in threads the bot has joined.',
        },
        {
          label: 'Mention only',
          value: 'mention-only',
          description: 'Only respond when explicitly @mentioned.',
        },
        {
          label: 'Always',
          value: 'always',
          description: 'Respond to every message in every channel.',
        },
      ],
      displayAs: 'radio-cards',
    },
    {
      key: 'dmPolicy',
      label: 'DM Access',
      type: 'select',
      // Required with an explicit default so the form always shows a choice.
      // Left optional, a person who never touched this field silently got the
      // permissive value (DOR-604).
      required: true,
      default: 'allowlist',
      description: 'Control who can DM the bot. A DM can start an agent turn on your machine.',
      section: 'Access Control',
      options: [
        {
          label: 'Open (anyone)',
          value: 'open',
          description: 'Any workspace member can DM the bot, and start a turn on your machine.',
        },
        {
          label: 'Allowlist only',
          value: 'allowlist',
          description: 'Only users in the allowlist can DM the bot.',
        },
      ],
      displayAs: 'radio-cards',
    },
    {
      key: 'dmAllowlist',
      label: 'DM Allowlist',
      type: 'textarea',
      required: false,
      description: 'Slack user IDs allowed to DM the bot (one per line).',
      placeholder: 'U01ABC123\nU02DEF456',
      section: 'Access Control',
      showWhen: { field: 'dmPolicy', equals: 'allowlist' },
    },
    {
      key: 'channelOverrides',
      label: 'Channel Overrides',
      type: 'textarea',
      required: false,
      description: 'Per-channel settings as JSON.',
      placeholder: '{"C01ABC": {"respondMode": "always"}, "C02DEF": {"enabled": false}}',
      section: 'Access Control',
    },
  ],
  setupInstructions:
    '1. Create a Slack app at api.slack.com/apps (From Scratch, not From Manifest).\n' +
    '2. Enable Socket Mode (Settings \u2192 Socket Mode).\n' +
    '3. Enable Event Subscriptions and subscribe to bot events: app_mention, message.channels, message.groups, message.im, message.mpim.\n' +
    '4. Add bot token scopes under OAuth & Permissions: app_mentions:read, channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, im:write, mpim:history, reactions:read, reactions:write, users:read.\n' +
    '5. Install the app to your workspace (OAuth & Permissions \u2192 Install).\n' +
    '6. Copy the Bot User OAuth Token (starts with xoxb-).\n' +
    '7. Generate an App-Level Token with connections:write scope (Basic Information \u2192 App-Level Tokens).\n' +
    '8. Copy the Signing Secret from Basic Information.\n\n' +
    '\u26a0\ufe0f Do NOT enable "Agents & AI Apps" \u2014 it adds user-level scopes that cause invalid_scope errors on most workspace plans.',
};
