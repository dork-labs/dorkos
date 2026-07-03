import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { RuntimeSetupPanel } from '@/layers/entities/runtime';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';

const noop = () => {};

const MOCK_REQUIREMENTS_CODEX_MISSING: SystemRequirements = {
  runtimes: {
    'claude-code': {
      dependencies: [
        {
          name: 'Claude Code CLI',
          description: 'The Claude Code CLI powers agent sessions in DorkOS.',
          status: 'satisfied',
          version: '1.0.31',
        },
      ],
    },
    codex: {
      dependencies: [
        {
          name: 'Codex CLI',
          description: 'The Codex CLI binary.',
          status: 'missing',
          installHint: 'npm i -g @openai/codex && codex login',
          infoUrl: 'https://developers.openai.com/codex',
        },
        {
          name: 'Codex login',
          description: 'ChatGPT OAuth or CODEX_API_KEY.',
          status: 'satisfied',
        },
      ],
    },
  },
  allSatisfied: false,
};

/**
 * Runtime setup guidance panel — the content of the RuntimeSetupDialog opened
 * from the status-bar runtime picker's needs-setup entries and from agent
 * launch surfaces (spec additional-agent-runtimes, 4.1).
 */
export function RuntimeSetupShowcases() {
  return (
    <PlaygroundSection
      title="RuntimeSetupPanel"
      description="Runtime setup guidance opened from the status-bar runtime picker and agent launch surfaces — per-dependency status with copyable install/auth commands. Guidance, not error: unsatisfied checks render amber, ready runtimes settle to a quiet check."
    >
      <ShowcaseLabel>Scoped — registered runtime with a missing dependency</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-md">
          <RuntimeSetupPanel
            runtime="codex"
            requirements={MOCK_REQUIREMENTS_CODEX_MISSING}
            registeredTypes={['claude-code', 'codex']}
            onRecheck={noop}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Scoped — ready runtime</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-md">
          <RuntimeSetupPanel
            runtime="claude-code"
            requirements={MOCK_REQUIREMENTS_CODEX_MISSING}
            registeredTypes={['claude-code', 'codex']}
            onRecheck={noop}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Scoped — known runtime not registered with this server</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-md">
          <RuntimeSetupPanel
            runtime="opencode"
            requirements={MOCK_REQUIREMENTS_CODEX_MISSING}
            registeredTypes={['claude-code', 'codex']}
            onRecheck={noop}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>{'Unscoped — the "Add a runtime" overview'}</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-md">
          <RuntimeSetupPanel
            requirements={MOCK_REQUIREMENTS_CODEX_MISSING}
            registeredTypes={['claude-code', 'codex']}
            onRecheck={noop}
            isRechecking={false}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
