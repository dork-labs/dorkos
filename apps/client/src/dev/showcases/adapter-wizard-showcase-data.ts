import type { AdapterManifest, ConfigField } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Slack adapter mock data — mirrors the real SLACK_MANIFEST from
// packages/relay/src/adapters/slack/slack-adapter.ts
// ---------------------------------------------------------------------------

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
    url: 'https://api.slack.com/apps?new_app=1',
  },
  setupSteps: [
    {
      stepId: 'create-app',
      title: 'Create & Configure a Slack App',
      description:
        'Go to api.slack.com/apps → Create New App → From Scratch.\n\n' +
        '1. **Socket Mode** — Enable it (Settings → Socket Mode).\n' +
        '2. **Event Subscriptions** — Turn on Enable Events.\n' +
        '3. **OAuth & Permissions** — Add bot token scopes.\n' +
        '4. **App-Level Token** — Generate with connections:write scope.',
      fields: ['botToken', 'appToken', 'signingSecret', 'streaming', 'typingIndicator'],
    },
  ],
  setupInstructions:
    '1. Create a Slack app at api.slack.com/apps (From Scratch).\n' +
    '2. Enable Socket Mode.\n' +
    '3. Subscribe to bot events: message.channels, message.im, app_mention.\n' +
    '4. Add scopes: channels:history, chat:write, im:history, reactions:write.\n' +
    '5. Install to your workspace and copy the Bot Token.',
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
      helpMarkdown:
        '1. Go to your [Slack App Settings](https://api.slack.com/apps)\n' +
        '2. Navigate to **OAuth & Permissions**\n' +
        '3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)',
    },
    {
      key: 'appToken',
      label: 'App-Level Token',
      type: 'password',
      required: true,
      placeholder: 'xapp-...',
      description: 'App-Level Token with connections:write scope.',
      pattern: '^xapp-',
      patternMessage: 'App tokens start with xapp-',
      visibleByDefault: true,
      helpMarkdown:
        '1. Go to **Basic Information** → **App-Level Tokens**\n' +
        '2. Click **Generate Token and Scopes**\n' +
        '3. Add `connections:write` scope\n' +
        '4. Copy the token (starts with `xapp-`)',
    },
    {
      key: 'signingSecret',
      label: 'Signing Secret',
      type: 'password',
      required: true,
      placeholder: 'abc123...',
      description: 'Signing Secret from Basic Information page.',
      helpMarkdown:
        '1. Go to **Basic Information** → **App Credentials**\n' +
        '2. Click **Show** next to Signing Secret and copy it',
    },
    {
      key: 'streaming',
      label: 'Stream Responses',
      type: 'boolean',
      required: false,
      description: 'Show responses as they arrive via message editing.',
      visibleByDefault: true,
    },
    {
      key: 'typingIndicator',
      label: 'Typing Indicator',
      type: 'select',
      required: false,
      description: 'Show a visual indicator while the agent is working.',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Emoji reaction', value: 'reaction' },
      ],
      visibleByDefault: true,
    },
  ],
};

/** Filled config values for demos that need populated data. */
export const FILLED_VALUES: Record<string, unknown> = {
  botToken: 'placeholder-bot-token-for-demo',
  appToken: 'placeholder-app-token-for-demo',
  signingSecret: 'placeholder-signing-secret',
  streaming: true,
  typingIndicator: 'reaction',
};

export const MOCK_AGENTS = [
  { id: 'agent-alpha', name: 'Code Reviewer' },
  { id: 'agent-beta', name: 'Deploy Bot' },
  { id: 'agent-gamma', name: 'Support Agent' },
];

export const SETUP_GUIDE_MARKDOWN = `## Getting Started

### 1. Create a Slack App

Visit [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From Scratch**.

### 2. Enable Socket Mode

Go to **Settings** → **Socket Mode** and toggle it on.

### 3. Configure Event Subscriptions

Under **Event Subscriptions**, turn on **Enable Events** and subscribe to:
- \`message.channels\`
- \`message.groups\`
- \`message.im\`
- \`app_mention\`

### 4. Add Bot Scopes

Navigate to **OAuth & Permissions** and add these bot token scopes:
- \`channels:history\`, \`channels:read\`, \`chat:write\`
- \`im:history\`, \`im:read\`, \`im:write\`
- \`reactions:write\`, \`users:read\`

### 5. Install & Copy Tokens

Install the app to your workspace, then copy the **Bot User OAuth Token**.`;

// ---------------------------------------------------------------------------
// ConfigFieldInput field-type showcase data — demonstrates every field type
// ---------------------------------------------------------------------------

export const ALL_FIELD_TYPES: ConfigField[] = [
  {
    key: 'text-demo',
    label: 'Text Field',
    type: 'text',
    required: true,
    placeholder: 'Enter text...',
    description: 'A standard text input.',
  },
  {
    key: 'password-demo',
    label: 'Password Field',
    type: 'password',
    required: true,
    placeholder: 'xoxb-...',
    description: 'Masked input with show/hide toggle.',
    visibleByDefault: true,
    pattern: '^xoxb-',
    patternMessage: 'Must start with xoxb-',
  },
  {
    key: 'url-demo',
    label: 'URL Field',
    type: 'url',
    required: false,
    placeholder: 'https://example.com',
    description: 'URL-typed input.',
  },
  {
    key: 'number-demo',
    label: 'Number Field',
    type: 'number',
    required: false,
    placeholder: '30',
    description: 'Numeric input.',
  },
  {
    key: 'boolean-demo',
    label: 'Boolean Toggle',
    type: 'boolean',
    required: false,
    description: 'Switch component for boolean fields.',
  },
  {
    key: 'select-demo',
    label: 'Select Dropdown',
    type: 'select',
    required: false,
    description: 'Standard dropdown selector.',
    options: [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
      { label: 'Option C', value: 'c' },
    ],
  },
  {
    key: 'textarea-demo',
    label: 'Textarea',
    type: 'textarea',
    required: false,
    placeholder: 'Enter multiline text...',
    description: 'Multiline text input.',
  },
  {
    key: 'help-demo',
    label: 'Field with Help',
    type: 'text',
    required: false,
    description: 'Click the help link below.',
    helpMarkdown:
      '**Tip:** You can find this value in your dashboard under **Settings** → **API Keys**.',
  },
];

// ---------------------------------------------------------------------------
// ConfigFieldInput error state showcase data
// ---------------------------------------------------------------------------

export const ERROR_FIELDS: ConfigField[] = [
  {
    key: 'api-key',
    label: 'API Key',
    type: 'text',
    required: true,
    placeholder: 'Enter your API key...',
    description: 'Required text field with validation error.',
  },
  {
    key: 'secret',
    label: 'Secret Token',
    type: 'password',
    required: true,
    placeholder: 'xoxb-...',
    description: 'Password field with pattern error.',
    pattern: '^xoxb-',
    patternMessage: 'Must start with xoxb-',
  },
  {
    key: 'auto-reconnect',
    label: 'Auto Reconnect',
    type: 'boolean',
    required: false,
    description: 'Boolean field with error state.',
  },
  {
    key: 'region',
    label: 'Region',
    type: 'select',
    required: true,
    description: 'Select field with required error.',
    options: [
      { label: 'US East', value: 'us-east' },
      { label: 'EU West', value: 'eu-west' },
    ],
  },
];

export const ERROR_MAP: Record<string, string> = {
  'api-key': 'API Key is required.',
  secret: 'Must start with xoxb-',
  'auto-reconnect': 'Auto reconnect requires a valid connection.',
  region: 'Region is required.',
};
