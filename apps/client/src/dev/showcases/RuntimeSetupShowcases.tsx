import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ModelNatureBadge, RuntimeSetupPanel } from '@/layers/entities/runtime';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';

const noop = () => {};

/**
 * A realistic requirements payload: Claude Ready, Codex needs a login connect,
 * OpenCode needs a one-click install connect — each carrying the server's
 * derived `state`/`connect` projection.
 */
const MOCK_REQUIREMENTS: SystemRequirements = {
  runtimes: {
    'claude-code': {
      state: 'ready',
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
      state: 'connect',
      connect: { kind: 'login', label: 'Connect Codex' },
      dependencies: [
        { name: 'Codex CLI', description: 'The Codex CLI binary.', status: 'satisfied' },
        {
          name: 'Codex authentication',
          description: 'ChatGPT OAuth or CODEX_API_KEY.',
          status: 'missing',
          installHint: 'codex login',
          infoUrl: 'https://developers.openai.com/codex',
        },
      ],
    },
    opencode: {
      state: 'connect',
      connect: { kind: 'install', label: 'Install OpenCode' },
      dependencies: [
        {
          name: 'OpenCode CLI',
          description: 'The OpenCode binary.',
          status: 'missing',
          installHint: 'npm i -g opencode-ai',
        },
      ],
    },
  },
};

/**
 * Runtime setup panel — the content of the RuntimeSetupDialog opened from the
 * status-bar runtime picker and agent launch surfaces. Each runtime is a
 * sibling: Ready, or a single Connect action. Binary/CLI detail and copyable
 * install commands live behind each runtime's Advanced disclosure.
 */
export function RuntimeSetupShowcases() {
  return (
    <>
      <RuntimeSetupPanelShowcase />
      <ModelNatureBadgeShowcase />
    </>
  );
}

/** Ready/Connect setup surface — the three sibling runtimes. */
function RuntimeSetupPanelShowcase() {
  return (
    <PlaygroundSection
      title="RuntimeSetupPanel"
      description="Ready/Connect setup surface. Every runtime renders identically as a sibling: a green Ready badge, or one Connect call-to-action built from the server's honest label. OpenCode installs in one click; the per-dependency detail and terminal steps are tucked behind an Advanced disclosure, collapsed by default."
    >
      <ShowcaseLabel>{'Overview — the three siblings (Ready / Connect)'}</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-md">
          <RuntimeSetupPanel
            requirements={MOCK_REQUIREMENTS}
            registeredTypes={['claude-code', 'codex']}
            onRecheck={noop}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Scoped — Ready runtime</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-md">
          <RuntimeSetupPanel
            runtime="claude-code"
            requirements={MOCK_REQUIREMENTS}
            registeredTypes={['claude-code', 'codex']}
            onRecheck={noop}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Scoped — Connect (login)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-md">
          <RuntimeSetupPanel
            runtime="codex"
            requirements={MOCK_REQUIREMENTS}
            registeredTypes={['claude-code', 'codex']}
            onRecheck={noop}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Scoped — Connect (one-click install)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-md">
          <RuntimeSetupPanel
            runtime="opencode"
            requirements={MOCK_REQUIREMENTS}
            registeredTypes={['claude-code', 'codex']}
            onRecheck={noop}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * Per-model nature badges — the honest privacy/cost + capability read at the
 * point of model choice. Derived from provider/locality, never a per-model
 * table; a local model is never oversold as frontier.
 */
function ModelNatureBadgeShowcase() {
  return (
    <PlaygroundSection
      title="ModelNatureBadge"
      description="An honest per-model read at the point of choice: 🔒 local · private · free vs $ cloud · per-token, plus a capability line that never sells a local model as frontier-equivalent (spec decision 11; DOR-180 honesty rule)."
    >
      <ShowcaseLabel>Compact badges (inline, at the point of choice)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex flex-wrap items-center gap-3">
          <ModelNatureBadge provider="ollama" modelId="qwen2.5-coder:7b" />
          <ModelNatureBadge provider="ollama" modelId="qwen2.5-coder:32b" />
          <ModelNatureBadge provider="openrouter" modelId="anthropic/claude-3.5-sonnet" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Detail — small local model (honest sub-14B caveat)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="max-w-md">
          <ModelNatureBadge provider="ollama" modelId="qwen2.5-coder:7b" detail />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Detail — capable local model (14B+)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="max-w-md">
          <ModelNatureBadge provider="ollama" modelId="qwen2.5-coder:32b" detail />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Detail — cloud model (per-token, frontier available)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="max-w-md">
          <ModelNatureBadge provider="openrouter" modelId="anthropic/claude-3.5-sonnet" detail />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
