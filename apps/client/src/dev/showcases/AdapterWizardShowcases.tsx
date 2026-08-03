import * as React from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Button } from '@/layers/shared/ui/button';
import { ConfigFieldGroup, ConfigFieldInput, AdapterBindingRow } from '@/layers/features/relay';
import { StepIndicator } from '@/layers/features/relay/ui/wizard/StepIndicator';
import { TestStep } from '@/layers/features/relay/ui/wizard/TestStep';
import { ConfirmStep } from '@/layers/features/relay/ui/wizard/ConfirmStep';
import { AgentStep } from '@/layers/features/relay/ui/wizard/AgentStep';
import { SetupGuideSheet } from '@/layers/features/relay/ui/SetupGuideSheet';
import {
  SLACK_MANIFEST,
  FILLED_VALUES,
  MOCK_AGENTS,
  SETUP_GUIDE_MARKDOWN,
  ALL_FIELD_TYPES,
  ERROR_FIELDS,
  ERROR_MAP,
} from './adapter-wizard-showcase-data';

// ---------------------------------------------------------------------------
// Showcase sub-components
// ---------------------------------------------------------------------------

function StepIndicatorShowcase() {
  const steps = ['agent', 'configure', 'test', 'confirm'] as const;

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
              <StepIndicator current={step} showAgentStep={true} />
            </div>
          </ShowcaseDemo>
        </div>
      ))}
      <ShowcaseLabel>Without the agent step (edit mode)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-xs">
          <StepIndicator current="test" showAgentStep={false} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ConfigureStepShowcase() {
  return (
    <PlaygroundSection
      title="ConfigureStep"
      description="Full configure form step with Slack adapter fields, setup instructions, and action button. Use AdapterSetupWizard for a live demo."
    >
      <ShowcaseDemo>
        <div className="text-muted-foreground mx-auto max-w-md text-sm">
          ConfigureStep requires a TanStack Form instance from AdapterSetupWizard. Open the full
          wizard via AdapterCard to interact with this step.
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
            allValues={values}
            renderField={(field) => (
              <ConfigFieldInput
                key={field.key}
                field={field}
                value={values[field.key]}
                onChange={handleChange}
                error={errors[field.key]}
                allValues={values}
              />
            )}
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
            allValues={values}
            renderField={(field) => (
              <ConfigFieldInput
                key={field.key}
                field={field}
                value={values[field.key]}
                onChange={handleChange}
                error={ERROR_MAP[field.key]}
                allValues={values}
              />
            )}
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
      description="Reachability test step with pending, success, and error states."
    >
      <ShowcaseLabel>Pending</ShowcaseLabel>
      <ShowcaseDemo>
        <TestStep isPending isSuccess={false} isError={false} onRetry={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>Success (with bot username)</ShowcaseLabel>
      <ShowcaseDemo>
        <TestStep
          isPending={false}
          isSuccess
          isError={false}
          botUsername="dorkos-bot"
          onRetry={() => {}}
        />
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

function AgentStepShowcase() {
  const [agentId, setAgentId] = React.useState('');
  const [strategy, setStrategy] = React.useState<'per-chat' | 'per-user' | 'stateless'>('per-chat');

  return (
    <PlaygroundSection
      title="AgentStep"
      description="Step one of the setup wizard — who answers. Three variants: no agents, one agent (chosen for you), and several agents with a picker."
    >
      <ShowcaseLabel>No agents registered</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-sm">
          <AgentStep
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
          <AgentStep
            agentOptions={[MOCK_AGENTS[0]!]}
            agentId={MOCK_AGENTS[0]!.id}
            onAgentIdChange={() => {}}
            strategy="per-chat"
            onStrategyChange={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Multiple agents (interactive)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="mx-auto max-w-sm">
          <AgentStep
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
      <AgentStepShowcase />
      <SetupGuideSheetShowcase />
      <AdapterBindingRowShowcase />
    </>
  );
}
