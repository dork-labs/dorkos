import * as React from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Button } from '@/layers/shared/ui/button';
import { ConfigFieldGroup, AdapterBindingRow } from '@/layers/features/relay';
import { StepIndicator } from '@/layers/features/relay/ui/wizard/StepIndicator';
import { ConfigureStep } from '@/layers/features/relay/ui/wizard/ConfigureStep';
import { TestStep } from '@/layers/features/relay/ui/wizard/TestStep';
import { ConfirmStep } from '@/layers/features/relay/ui/wizard/ConfirmStep';
import { BindStep } from '@/layers/features/relay/ui/wizard/BindStep';
import { SetupGuideSheet } from '@/layers/features/relay/ui/SetupGuideSheet';
import type { AdapterManifest, ConfigField } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Slack adapter mock data — mirrors the real SLACK_MANIFEST from
// packages/relay/src/adapters/slack/slack-adapter.ts
// ---------------------------------------------------------------------------

const SLACK_MANIFEST: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Send and receive messages in Slack channels and DMs.',
  iconEmoji: '#',
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
const FILLED_VALUES: Record<string, unknown> = {
  botToken: 'placeholder-bot-token-for-demo',
  appToken: 'placeholder-app-token-for-demo',
  signingSecret: 'placeholder-signing-secret',
  streaming: true,
  typingIndicator: 'reaction',
};

const MOCK_AGENTS = [
  { id: 'agent-alpha', name: 'Code Reviewer' },
  { id: 'agent-beta', name: 'Deploy Bot' },
  { id: 'agent-gamma', name: 'Support Agent' },
];

const SETUP_GUIDE_MARKDOWN = `## Getting Started

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

const ALL_FIELD_TYPES: ConfigField[] = [
  { key: 'text-demo', label: 'Text Field', type: 'text', required: true, placeholder: 'Enter text...', description: 'A standard text input.' },
  { key: 'password-demo', label: 'Password Field', type: 'password', required: true, placeholder: 'xoxb-...', description: 'Masked input with show/hide toggle.', visibleByDefault: true, pattern: '^xoxb-', patternMessage: 'Must start with xoxb-' },
  { key: 'url-demo', label: 'URL Field', type: 'url', required: false, placeholder: 'https://example.com', description: 'URL-typed input.' },
  { key: 'number-demo', label: 'Number Field', type: 'number', required: false, placeholder: '30', description: 'Numeric input.' },
  { key: 'boolean-demo', label: 'Boolean Toggle', type: 'boolean', required: false, description: 'Switch component for boolean fields.' },
  { key: 'select-demo', label: 'Select Dropdown', type: 'select', required: false, description: 'Standard dropdown selector.', options: [{ label: 'Option A', value: 'a' }, { label: 'Option B', value: 'b' }, { label: 'Option C', value: 'c' }] },
  { key: 'textarea-demo', label: 'Textarea', type: 'textarea', required: false, placeholder: 'Enter multiline text...', description: 'Multiline text input.' },
  { key: 'help-demo', label: 'Field with Help', type: 'text', required: false, description: 'Click the help link below.', helpMarkdown: '**Tip:** You can find this value in your dashboard under **Settings** → **API Keys**.' },
];

// ---------------------------------------------------------------------------
// ConfigFieldInput error state showcase data
// ---------------------------------------------------------------------------

const ERROR_FIELDS: ConfigField[] = [
  { key: 'api-key', label: 'API Key', type: 'text', required: true, placeholder: 'Enter your API key...', description: 'Required text field with validation error.' },
  { key: 'secret', label: 'Secret Token', type: 'password', required: true, placeholder: 'xoxb-...', description: 'Password field with pattern error.', pattern: '^xoxb-', patternMessage: 'Must start with xoxb-' },
  { key: 'auto-reconnect', label: 'Auto Reconnect', type: 'boolean', required: false, description: 'Boolean field with error state.' },
  { key: 'region', label: 'Region', type: 'select', required: true, description: 'Select field with required error.', options: [{ label: 'US East', value: 'us-east' }, { label: 'EU West', value: 'eu-west' }] },
];

const ERROR_MAP: Record<string, string> = {
  'api-key': 'API Key is required.',
  'secret': 'Must start with xoxb-',
  'auto-reconnect': 'Auto reconnect requires a valid connection.',
  'region': 'Region is required.',
};

// ---------------------------------------------------------------------------
// Showcase sub-components
// ---------------------------------------------------------------------------

function StepIndicatorShowcase() {
  const steps = ['configure', 'test', 'confirm', 'bind'] as const;

  return (
    <PlaygroundSection
      title="StepIndicator"
      description="Visual wizard step indicator showing completed, active, and pending states."
    >
      {steps.map((step) => (
        <div key={step}>
          <ShowcaseLabel>{`current="${step}"`}</ShowcaseLabel>
          <ShowcaseDemo>
            <div className="mx-auto max-w-xs">
              <StepIndicator current={step} showBindStep={true} />
            </div>
          </ShowcaseDemo>
        </div>
      ))}
      <ShowcaseLabel>Without bind step (edit mode)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-xs">
          <StepIndicator current="test" showBindStep={false} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ConfigureStepShowcase() {
  const [label, setLabel] = React.useState('');
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [errors] = React.useState<Record<string, string>>({});

  const handleChange = React.useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <PlaygroundSection
      title="ConfigureStep"
      description="Full configure form step with Slack adapter fields, setup instructions, and action button."
    >
      <ShowcaseDemo>
        <div className="mx-auto max-w-md">
          <ConfigureStep
            manifest={SLACK_MANIFEST}
            label={label}
            onLabelChange={setLabel}
            fields={SLACK_MANIFEST.configFields}
            values={values}
            errors={errors}
            onChange={handleChange}
            currentSetupStep={SLACK_MANIFEST.setupSteps?.[0]}
            hasSetupGuide
            onOpenGuide={() => {}}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ConfigFieldInputShowcase() {
  const [values, setValues] = React.useState<Record<string, unknown>>({
    'boolean-demo': true,
    'select-demo': 'b',
  });
  const [errors] = React.useState<Record<string, string>>({});

  const handleChange = React.useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <PlaygroundSection
      title="ConfigFieldInput"
      description="Dynamic form control renderer supporting text, password, url, number, boolean, select, and textarea field types."
    >
      <ShowcaseDemo>
        <div className="mx-auto max-w-md">
          <ConfigFieldGroup
            fields={ALL_FIELD_TYPES}
            values={values}
            onChange={handleChange}
            errors={errors}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ConfigFieldInputErrorShowcase() {
  const [values, setValues] = React.useState<Record<string, unknown>>({});

  const handleChange = React.useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <PlaygroundSection
      title="ConfigFieldInput — Error States"
      description="Demonstrates error message rendering across text, password, boolean, and select field types."
    >
      <ShowcaseDemo>
        <div className="mx-auto max-w-md">
          <ConfigFieldGroup
            fields={ERROR_FIELDS}
            values={values}
            onChange={handleChange}
            errors={ERROR_MAP}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function TestStepShowcase() {
  return (
    <PlaygroundSection
      title="TestStep"
      description="Connection test step with pending, success, and error states."
    >
      <ShowcaseLabel>Pending</ShowcaseLabel>
      <ShowcaseDemo>
        <TestStep isPending isSuccess={false} isError={false} onRetry={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>Success (with bot username)</ShowcaseLabel>
      <ShowcaseDemo>
        <TestStep isPending={false} isSuccess isError={false} botUsername="dorkos-bot" onRetry={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>Error</ShowcaseLabel>
      <ShowcaseDemo>
        <TestStep
          isPending={false}
          isSuccess={false}
          isError
          errorMessage="invalid_auth: The token provided is not valid. Check that your Bot Token starts with xoxb- and has the required scopes."
          onRetry={() => {}}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ConfirmStepShowcase() {
  return (
    <PlaygroundSection
      title="ConfirmStep"
      description="Review summary before saving. Passwords are masked with partial reveal."
    >
      <ShowcaseLabel>Add mode (shows adapter ID)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-sm">
          <ConfirmStep
            manifest={SLACK_MANIFEST}
            adapterId="slack"
            isEditMode={false}
            values={FILLED_VALUES}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Edit mode (hides adapter ID)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-sm">
          <ConfirmStep
            manifest={SLACK_MANIFEST}
            adapterId="slack"
            isEditMode
            values={FILLED_VALUES}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function BindStepShowcase() {
  const [agentId, setAgentId] = React.useState('');
  const [strategy, setStrategy] = React.useState<'per-chat' | 'per-user' | 'stateless'>('per-chat');

  return (
    <PlaygroundSection
      title="BindStep"
      description="Agent binding step with three UI variants: no agents, single agent (auto-selected), and multiple agents with dropdown."
    >
      <ShowcaseLabel>No agents registered</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-sm">
          <BindStep
            agentOptions={[]}
            agentId=""
            onAgentIdChange={() => {}}
            strategy="per-chat"
            onStrategyChange={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Single agent (auto-selected)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-sm">
          <BindStep
            agentOptions={[MOCK_AGENTS[0]!]}
            agentId={MOCK_AGENTS[0]!.id}
            onAgentIdChange={() => {}}
            strategy="per-chat"
            onStrategyChange={() => {}}
            botUsername="dorkos-bot"
            adapterType="slack"
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Multiple agents (interactive)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-sm">
          <BindStep
            agentOptions={MOCK_AGENTS}
            agentId={agentId}
            onAgentIdChange={setAgentId}
            strategy={strategy}
            onStrategyChange={setStrategy}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function SetupGuideSheetShowcase() {
  const [open, setOpen] = React.useState(false);

  return (
    <PlaygroundSection
      title="SetupGuideSheet"
      description="Slide-out right panel rendering adapter setup guide markdown alongside the wizard."
    >
      <ShowcaseDemo>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Open Slack Setup Guide
        </Button>
        <SetupGuideSheet
          open={open}
          onOpenChange={setOpen}
          title="Slack"
          content={SETUP_GUIDE_MARKDOWN}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function AdapterBindingRowShowcase() {
  return (
    <PlaygroundSection
      title="AdapterBindingRow"
      description="Compact row showing an adapter→agent binding with strategy, chat, and permission indicators."
    >
      <ShowcaseLabel>Default (per-chat, all permissions)</ShowcaseLabel>
      <ShowcaseDemo>
        <AdapterBindingRow agentName="Code Reviewer" sessionStrategy="per-chat" />
      </ShowcaseDemo>

      <ShowcaseLabel>Per-user strategy with channel</ShowcaseLabel>
      <ShowcaseDemo>
        <AdapterBindingRow
          agentName="Support Agent"
          sessionStrategy="per-user"
          chatId="help-desk"
          channelType="channel"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Can initiate + reply disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <AdapterBindingRow
          agentName="Deploy Bot"
          sessionStrategy="stateless"
          canInitiate
          canReply={false}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Receive disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <AdapterBindingRow
          agentName="Notification Agent"
          sessionStrategy="per-chat"
          canReceive={false}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** Adapter setup wizard component showcases using Slack adapter mock data. */
export function AdapterWizardShowcases() {
  return (
    <>
      <StepIndicatorShowcase />
      <ConfigureStepShowcase />
      <ConfigFieldInputShowcase />
      <ConfigFieldInputErrorShowcase />
      <TestStepShowcase />
      <ConfirmStepShowcase />
      <BindStepShowcase />
      <SetupGuideSheetShowcase />
      <AdapterBindingRowShowcase />
    </>
  );
}
