import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, Copy, KeyRound } from 'lucide-react';
import type { ServerConfig } from '@dorkos/shared/types';
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FieldCard,
  FieldCardContent,
  Input,
  SettingRow,
  Switch,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useCopyFeedback } from '../lib/use-copy-feedback';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type McpConfig = NonNullable<ServerConfig['mcp']>;

interface ExternalMcpCardProps {
  mcp: McpConfig;
}

// ---------------------------------------------------------------------------
// CopyButton — small icon button with copy/check feedback
// ---------------------------------------------------------------------------

function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, copy] = useCopyFeedback();
  return (
    <button
      className={cn(
        'text-muted-foreground hover:text-foreground rounded-sm p-1 transition-colors',
        className
      )}
      onClick={() => copy(value)}
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Setup instruction snippets per client
// ---------------------------------------------------------------------------

function buildSnippets(endpoint: string, apiKey: string | null) {
  const authHeader = apiKey ? `Bearer ${apiKey}` : 'Bearer dork_mcp_YOUR_API_KEY';

  return {
    claudeCode: JSON.stringify(
      {
        mcpServers: {
          'dorkos-external': {
            type: 'http',
            url: endpoint,
            headers: { Authorization: authHeader },
          },
        },
      },
      null,
      2
    ),
    claudeCodeCli: `claude mcp add-json dorkos-external '${JSON.stringify({
      type: 'http',
      url: endpoint,
      headers: { Authorization: authHeader },
    })}'`,
    cursor: JSON.stringify(
      {
        mcpServers: {
          'dorkos-external': {
            url: endpoint,
            headers: { Authorization: authHeader },
          },
        },
      },
      null,
      2
    ),
    windsurf: JSON.stringify(
      {
        mcpServers: {
          'dorkos-external': {
            serverUrl: endpoint,
            headers: { Authorization: authHeader },
          },
        },
      },
      null,
      2
    ),
  };
}

// ---------------------------------------------------------------------------
// ExternalMcpCard
// ---------------------------------------------------------------------------

/**
 * External MCP Server card for the ToolsTab.
 *
 * Provides a collapsible control surface for the external MCP endpoint: enable/disable
 * toggle, API key lifecycle, rate limiting, per-client setup instructions, and
 * a duplicate-tool collision warning.
 */
export function ExternalMcpCard({ mcp }: ExternalMcpCardProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupTab, setSetupTab] = useState<'claude-code' | 'cursor' | 'windsurf'>('claude-code');

  const invalidateConfig = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['config'] }),
    [queryClient]
  );

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      await transport.updateConfig({
        mcp: { enabled, rateLimit: mcp.rateLimit },
      });
      await invalidateConfig();
    },
    [transport, mcp.rateLimit, invalidateConfig]
  );

  const handleGenerateKey = useCallback(async () => {
    try {
      setKeyError(null);
      const { apiKey } = await transport.generateMcpApiKey();
      setGeneratedKey(apiKey);
      await invalidateConfig();
    } catch {
      setKeyError('Failed to generate API key.');
    }
  }, [transport, invalidateConfig]);

  const handleRotateKey = useCallback(async () => {
    try {
      setKeyError(null);
      await transport.deleteMcpApiKey();
      const { apiKey } = await transport.generateMcpApiKey();
      setGeneratedKey(apiKey);
      await invalidateConfig();
    } catch {
      setKeyError('Failed to rotate API key. The previous key may have been removed.');
      await invalidateConfig();
    }
  }, [transport, invalidateConfig]);

  const handleRemoveKey = useCallback(async () => {
    try {
      setKeyError(null);
      await transport.deleteMcpApiKey();
      setGeneratedKey(null);
      await invalidateConfig();
    } catch {
      setKeyError('Failed to remove API key.');
    }
  }, [transport, invalidateConfig]);

  const handleUpdateRateLimit = useCallback(
    async (patch: Partial<McpConfig['rateLimit']>) => {
      await transport.updateConfig({
        mcp: { enabled: mcp.enabled, rateLimit: { ...mcp.rateLimit, ...patch } },
      });
      await invalidateConfig();
    },
    [transport, mcp.enabled, mcp.rateLimit, invalidateConfig]
  );

  const statusBadge = mcp.enabled ? (
    mcp.authConfigured ? (
      <Badge variant="outline" className="border-green-500/50 text-xs text-green-600">
        Enabled
      </Badge>
    ) : (
      <Badge variant="outline" className="border-amber-500/50 text-xs text-amber-600">
        No auth
      </Badge>
    )
  ) : (
    <Badge variant="secondary" className="text-xs">
      Disabled
    </Badge>
  );

  const snippets = buildSnippets(mcp.endpoint, generatedKey);

  return (
    <FieldCard>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        {/* Header row — always visible */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">External MCP Server</p>
            <p className="text-muted-foreground text-xs">
              Add the DorkOS MCP to agents outside of DorkOS
            </p>
          </div>
          <div className="flex items-center gap-2">
            {statusBadge}
            <Switch
              checked={mcp.enabled}
              onCheckedChange={handleToggle}
              aria-label="Toggle external MCP access"
            />
            <CollapsibleTrigger asChild>
              <button
                className="text-muted-foreground hover:text-foreground rounded-sm p-0.5 transition-colors duration-150"
                aria-label={`${expanded ? 'Collapse' : 'Expand'} external MCP server settings`}
              >
                <ChevronDown
                  className={cn(
                    'size-3.5 transition-transform duration-150',
                    !expanded && '-rotate-90'
                  )}
                />
              </button>
            </CollapsibleTrigger>
          </div>
        </div>

        {/* Expanded content — sectioned with auto-dividers */}
        <CollapsibleContent>
          <FieldCardContent className="border-t">
            {/* ── Duplicate tool warning (first thing users see) ── */}
            <div className="flex gap-3 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="space-y-1">
                <p className="text-xs font-medium">
                  Do not configure this for agents running inside DorkOS.
                </p>
                <p className="text-muted-foreground text-xs">
                  DorkOS already provides tools to its managed agents internally. Adding DorkOS as
                  an external MCP server to those same agents causes duplicate tool names — the
                  Anthropic API will return HTTP 400 &ldquo;Tool names must be unique&rdquo; and all
                  tool calls will fail. External MCP access is for agents running{' '}
                  <strong>outside</strong> of DorkOS (standalone Claude Code, Cursor, Windsurf).
                </p>
              </div>
            </div>

            {/* ── Endpoint ── */}
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">Endpoint</p>
                <p className="text-muted-foreground text-xs">MCP server URL for external agents</p>
              </div>
              <div className="flex items-center gap-1.5">
                <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
                  {mcp.endpoint}
                </code>
                <CopyButton value={mcp.endpoint} />
              </div>
            </div>

            {/* ── API Key ── */}
            <ApiKeySection
              authConfigured={mcp.authConfigured}
              authSource={mcp.authSource}
              generatedKey={generatedKey}
              keyError={keyError}
              onGenerate={handleGenerateKey}
              onRotate={handleRotateKey}
              onRemove={handleRemoveKey}
            />

            {/* ── Rate Limiting ── */}
            <div className="space-y-3">
              <SettingRow
                label="Rate limiting"
                description="Limit external MCP requests per time window"
              >
                <Switch
                  checked={mcp.rateLimit.enabled}
                  onCheckedChange={(v) => handleUpdateRateLimit({ enabled: v })}
                  aria-label="Toggle rate limiting"
                />
              </SettingRow>
              {mcp.rateLimit.enabled && (
                <div className="space-y-3">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="text-muted-foreground text-xs">Max requests</label>
                      <Input
                        type="number"
                        min={1}
                        max={1000}
                        value={mcp.rateLimit.maxPerWindow}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 1 && v <= 1000) handleUpdateRateLimit({ maxPerWindow: v });
                        }}
                        className="w-20"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-muted-foreground text-xs">Window (sec)</label>
                      <Input
                        type="number"
                        min={1}
                        max={3600}
                        value={mcp.rateLimit.windowSecs}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (v >= 1 && v <= 3600) handleUpdateRateLimit({ windowSecs: v });
                        }}
                        className="w-20"
                      />
                    </div>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Rate limit changes take effect after server restart.
                  </p>
                </div>
              )}
            </div>

            {/* ── Setup Instructions (collapsible) ── */}
            <Collapsible open={setupOpen} onOpenChange={setSetupOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-between text-sm font-medium">
                <span>Setup Instructions</span>
                <ChevronDown
                  className={cn(
                    'text-muted-foreground size-3.5 transition-transform duration-150',
                    !setupOpen && '-rotate-90'
                  )}
                />
              </CollapsibleTrigger>

              <CollapsibleContent>
                <div className="mt-3 space-y-3">
                  {/* Tab buttons */}
                  <div className="bg-muted flex gap-0.5 rounded-md p-0.5">
                    {(['claude-code', 'cursor', 'windsurf'] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setSetupTab(tab)}
                        className={cn(
                          'flex-1 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors',
                          setupTab === tab
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {tab === 'claude-code'
                          ? 'Claude Code'
                          : tab === 'cursor'
                            ? 'Cursor'
                            : 'Windsurf'}
                      </button>
                    ))}
                  </div>

                  {/* Snippet */}
                  <div className="relative">
                    <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
                      {setupTab === 'claude-code' && snippets.claudeCode}
                      {setupTab === 'cursor' && snippets.cursor}
                      {setupTab === 'windsurf' && snippets.windsurf}
                    </pre>
                    <div className="absolute top-2 right-2">
                      <CopyButton
                        value={
                          setupTab === 'claude-code'
                            ? snippets.claudeCode
                            : setupTab === 'cursor'
                              ? snippets.cursor
                              : snippets.windsurf
                        }
                      />
                    </div>
                  </div>

                  {/* CLI command for Claude Code */}
                  {setupTab === 'claude-code' && (
                    <div className="relative">
                      <p className="text-muted-foreground mb-1 text-xs">Or add via CLI:</p>
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
                        {snippets.claudeCodeCli}
                      </pre>
                      <div className="absolute right-2 bottom-2">
                        <CopyButton value={snippets.claudeCodeCli} />
                      </div>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </FieldCardContent>
        </CollapsibleContent>
      </Collapsible>
    </FieldCard>
  );
}

// ---------------------------------------------------------------------------
// ApiKeySection — multi-line API key lifecycle
// ---------------------------------------------------------------------------

interface ApiKeySectionProps {
  authConfigured: boolean;
  authSource: 'config' | 'env' | 'none';
  generatedKey: string | null;
  keyError: string | null;
  onGenerate: () => void;
  onRotate: () => void;
  onRemove: () => void;
}

/** API key section with distinct visual states for none/generated/configured/env. */
function ApiKeySection({
  authConfigured,
  authSource,
  generatedKey,
  keyError,
  onGenerate,
  onRotate,
  onRemove,
}: ApiKeySectionProps) {
  const [copied, copy] = useCopyFeedback();

  // Env var managed — read-only
  if (authSource === 'env') {
    return (
      <SettingRow label="API Key" description="Set via MCP_API_KEY environment variable">
        <Badge variant="outline">Environment variable</Badge>
      </SettingRow>
    );
  }

  // No key configured — prompt to generate
  if (!authConfigured && !generatedKey) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">API Key</p>
            <p className="text-muted-foreground text-xs">
              Protect the MCP endpoint with bearer token authentication
            </p>
          </div>
          <Button size="sm" onClick={onGenerate}>
            <KeyRound className="mr-1.5 size-3.5" />
            Generate Key
          </Button>
        </div>
        {keyError && (
          <p className="text-xs text-red-500" role="alert">
            {keyError}
          </p>
        )}
      </div>
    );
  }

  // Just generated — one-time reveal
  if (generatedKey) {
    return (
      <div className="space-y-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">API Key</p>
          <p className="text-muted-foreground text-xs">
            Copy this key now — it won&apos;t be shown again
          </p>
        </div>
        <div className="flex items-center gap-2">
          <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
            {generatedKey}
          </code>
          <button
            className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-1.5 transition-colors"
            onClick={() => copy(generatedKey)}
            aria-label="Copy API key"
          >
            {copied ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
          </button>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onRotate}>
            Rotate
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
        {keyError && (
          <p className="text-xs text-red-500" role="alert">
            {keyError}
          </p>
        )}
      </div>
    );
  }

  // Key exists in config — masked display with actions
  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">API Key</p>
        <p className="text-muted-foreground text-xs">Bearer token for MCP authentication</p>
      </div>
      <div className="flex items-center gap-2">
        <code className="bg-muted rounded-md px-3 py-2 font-mono text-xs">dork_mcp_••••••••</code>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onRotate}>
          Rotate
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {keyError && (
        <p className="text-xs text-red-500" role="alert">
          {keyError}
        </p>
      )}
    </div>
  );
}
