import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Plug, Terminal } from 'lucide-react';
import { AnthropicLogo, OpenAILogo, GeminiLogo } from '@dorkos/icons/adapter-logos';
import { useTransport } from '@/layers/shared/model';
import {
  FieldCard,
  FieldCardContent,
  Input,
  SettingRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import {
  useAdapterCatalog,
  useRelayEnabled,
  useToggleAdapter,
  useUpdateAdapterConfig,
} from '@/layers/entities/relay';
import { AdapterRuntimeCard } from './AdapterRuntimeCard';

/** Agents section within Settings — default agent dropdown, runtimes, and DorkBot personality reset. */
export function AgentsTab() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  // Relay adapter data for the Claude Code runtime card.
  const relayEnabled = useRelayEnabled();
  const { data: catalog = [] } = useAdapterCatalog(relayEnabled);
  const { mutate: toggleAdapter } = useToggleAdapter();
  const { mutate: updateConfig } = useUpdateAdapterConfig();

  // Local controlled inputs for adapter config fields (persisted on blur).
  const [localMaxConcurrent, setLocalMaxConcurrent] = useState<string | null>(null);
  const [localTimeout, setLocalTimeout] = useState<string | null>(null);

  const { data: agentsData } = useQuery({
    queryKey: ['mesh', 'agents'],
    queryFn: () => transport.listMeshAgents(),
    staleTime: 30_000,
  });

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  // Derive Claude Code adapter state from the relay catalog.
  const claudeCodeEntry = useMemo(
    () =>
      catalog.find((e) => e.manifest.category === 'internal' && e.manifest.type === 'claude-code'),
    [catalog]
  );
  const claudeCodeInstance = claudeCodeEntry?.instances[0];
  const claudeCodeConfig = claudeCodeInstance?.config;

  // Resolved config values — local edits take precedence while editing.
  const maxConcurrent = localMaxConcurrent ?? String(claudeCodeConfig?.maxConcurrent ?? 3);
  const defaultTimeout = localTimeout ?? String(claudeCodeConfig?.defaultTimeoutMs ?? 300000);

  const agents = agentsData?.agents ?? [];
  const currentDefault = config?.agents?.defaultAgent ?? 'dorkbot';

  async function handleSetDefaultAgent(agentName: string) {
    await transport.setDefaultAgent(agentName);
    await queryClient.invalidateQueries({ queryKey: ['config'] });
  }

  function handleClaudeToggle(enabled: boolean) {
    if (claudeCodeInstance) {
      toggleAdapter({ id: claudeCodeInstance.id, enabled });
    }
  }

  function handleConfigBlur(key: string, value: string) {
    const numVal = Number(value);
    if (claudeCodeInstance && !Number.isNaN(numVal) && numVal > 0) {
      updateConfig({ id: claudeCodeInstance.id, config: { [key]: numVal } });
    }
    // Clear local override so the value tracks the persisted state.
    if (key === 'maxConcurrent') setLocalMaxConcurrent(null);
    if (key === 'defaultTimeoutMs') setLocalTimeout(null);
  }

  return (
    <>
      {agents.length > 0 && (
        <FieldCard>
          <FieldCardContent>
            <SettingRow
              label="Default agent"
              description="The primary agent used for new sessions and post-onboarding"
            >
              <Select value={currentDefault} onValueChange={handleSetDefaultAgent}>
                <SelectTrigger className="w-44" data-testid="default-agent-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.name}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </FieldCardContent>
        </FieldCard>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Runtimes</h3>
        <p className="text-muted-foreground text-xs">
          Configure which runtimes are available for agent sessions.
        </p>
        <AdapterRuntimeCard
          name="Claude Code"
          icon={AnthropicLogo}
          description="Anthropic's agentic coding runtime — powers all DorkOS sessions"
          status="active"
          enabled={claudeCodeInstance?.enabled ?? true}
          onToggle={claudeCodeInstance ? handleClaudeToggle : undefined}
        >
          <SettingRow
            label="Claude CLI"
            description={
              config?.claudeCliPath ??
              'Not found — install Claude Code CLI to enable agent sessions'
            }
          >
            {config?.claudeCliPath && (
              <span
                className="text-muted-foreground max-w-48 min-w-0 truncate font-mono text-xs"
                dir="rtl"
                title={config.claudeCliPath}
              >
                {config.claudeCliPath}
              </span>
            )}
          </SettingRow>
          {claudeCodeInstance && (
            <>
              <SettingRow
                label="Max concurrent sessions"
                description="Maximum relay-delivered sessions running simultaneously"
              >
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={maxConcurrent}
                  onChange={(e) => setLocalMaxConcurrent(e.target.value)}
                  onBlur={(e) => handleConfigBlur('maxConcurrent', e.target.value)}
                  className="w-24"
                />
              </SettingRow>
              <SettingRow
                label="Default timeout"
                description="Timeout budget per relay session in milliseconds"
              >
                <Input
                  type="number"
                  min={10000}
                  max={3600000}
                  value={defaultTimeout}
                  onChange={(e) => setLocalTimeout(e.target.value)}
                  onBlur={(e) => handleConfigBlur('defaultTimeoutMs', e.target.value)}
                  className="w-32"
                />
              </SettingRow>
            </>
          )}
        </AdapterRuntimeCard>

        <AdapterRuntimeCard
          name="Codex"
          icon={OpenAILogo}
          description="OpenAI's agentic coding runtime powered by o-series reasoning models"
          status="coming-soon"
          enabled={false}
        />

        <AdapterRuntimeCard
          name="Agent Protocol"
          icon={Plug}
          description="Connect any ACP-compatible coding agent — OpenCode, Cline, Goose, Copilot CLI"
          status="coming-soon"
          enabled={false}
        />

        <AdapterRuntimeCard
          name="Pi Agent"
          icon={Cpu}
          description="Run coding agents locally with Ollama, LM Studio, or any model provider"
          status="coming-soon"
          enabled={false}
        />

        <AdapterRuntimeCard
          name="Gemini CLI"
          icon={GeminiLogo}
          description="Google's agentic coding runtime powered by Gemini 2.5 models"
          status="coming-soon"
          enabled={false}
        />

        <AdapterRuntimeCard
          name="Aider"
          icon={Terminal}
          description="Multi-model coding agent supporting 20+ providers including local models"
          status="coming-soon"
          enabled={false}
        />
      </div>
    </>
  );
}
