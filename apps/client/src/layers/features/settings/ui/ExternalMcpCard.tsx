import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, Copy } from 'lucide-react';
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
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

function CopyButton({ value }: { value: string }) {
  const [copied, copy] = useCopyFeedback();
  return (
    <button
      className="text-muted-foreground hover:text-foreground rounded-sm p-1 transition-colors"
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
  const authHeader = apiKey ? `Bearer ${apiKey}` : 'Bearer dork_YOUR_API_KEY';

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
 * External MCP Access card for the ToolsTab.
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
  const [copied, copy] = useCopyFeedback();

  const invalidateConfig = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['config'] }),
    [queryClient]
  );

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      await transport.updateConfig({
        mcp: {
          enabled,
          rateLimit: mcp.rateLimit,
        },
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
        mcp: {
          enabled: mcp.enabled,
          rateLimit: { ...mcp.rateLimit, ...patch },
        },
      });
      await invalidateConfig();
    },
    [transport, mcp.enabled, mcp.rateLimit, invalidateConfig]
  );

  // Status badge logic
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
      <FieldCardContent>
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <SettingRow
            label="External Access"
            description="Allow external agents to use DorkOS tools via MCP"
          >
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
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} external access settings`}
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
          </SettingRow>

          <CollapsibleContent>
            <div className="border-border mt-2 space-y-3 border-t pt-3">
              {/* Endpoint URL */}
              <SettingRow label="Endpoint" description="MCP server URL for external agents">
                <div className="flex items-center gap-2">
                  <code className="bg-muted rounded px-2 py-1 text-xs">{mcp.endpoint}</code>
                  <CopyButton value={mcp.endpoint} />
                </div>
              </SettingRow>

              {/* Authentication */}
              <AuthSection
                authConfigured={mcp.authConfigured}
                authSource={mcp.authSource}
                generatedKey={generatedKey}
                copied={copied}
                onCopy={copy}
                onGenerate={handleGenerateKey}
                onRotate={handleRotateKey}
                onRemove={handleRemoveKey}
              />
              {keyError && (
                <p className="text-xs text-red-500" role="alert">
                  {keyError}
                </p>
              )}

              {/* Rate limiting */}
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
                <>
                  <SettingRow label="Max requests" description="Requests allowed per window">
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
                  </SettingRow>
                  <SettingRow label="Window (seconds)" description="Time window for rate limiting">
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
                  </SettingRow>
                  <p className="text-muted-foreground text-xs">
                    Rate limit changes take effect after server restart.
                  </p>
                </>
              )}

              {/* Setup instructions */}
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium">Setup Instructions</p>
                <Tabs defaultValue="claude-code" className="w-full">
                  <TabsList className="w-full">
                    <TabsTrigger value="claude-code" className="flex-1 text-xs">
                      Claude Code
                    </TabsTrigger>
                    <TabsTrigger value="cursor" className="flex-1 text-xs">
                      Cursor
                    </TabsTrigger>
                    <TabsTrigger value="windsurf" className="flex-1 text-xs">
                      Windsurf
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="claude-code" className="mt-2 space-y-2">
                    <div className="relative">
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                        {snippets.claudeCode}
                      </pre>
                      <div className="absolute top-2 right-2">
                        <CopyButton value={snippets.claudeCode} />
                      </div>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Or via CLI:{' '}
                      <code className="bg-muted rounded px-1 py-0.5 text-xs">
                        {snippets.claudeCodeCli}
                      </code>
                    </p>
                  </TabsContent>

                  <TabsContent value="cursor" className="mt-2">
                    <div className="relative">
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                        {snippets.cursor}
                      </pre>
                      <div className="absolute top-2 right-2">
                        <CopyButton value={snippets.cursor} />
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="windsurf" className="mt-2">
                    <div className="relative">
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                        {snippets.windsurf}
                      </pre>
                      <div className="absolute top-2 right-2">
                        <CopyButton value={snippets.windsurf} />
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>

              {/* Duplicate tool warning */}
              <div className="flex gap-3 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <div className="space-y-1">
                  <p className="text-xs font-medium">
                    Do not configure this for agents running inside DorkOS.
                  </p>
                  <p className="text-muted-foreground text-xs">
                    DorkOS already provides tools to its managed agents internally. Adding DorkOS as
                    an external MCP server to those same agents causes duplicate tool names — the
                    Anthropic API will return HTTP 400 &ldquo;Tool names must be unique&rdquo; and
                    all tool calls will fail. External MCP access is for agents running{' '}
                    <strong>outside</strong> of DorkOS (standalone Claude Code, Cursor, Windsurf).
                  </p>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </FieldCardContent>
    </FieldCard>
  );
}

// ---------------------------------------------------------------------------
// AuthSection — API key lifecycle sub-component
// ---------------------------------------------------------------------------

interface AuthSectionProps {
  authConfigured: boolean;
  authSource: 'config' | 'env' | 'none';
  generatedKey: string | null;
  copied: boolean;
  onCopy: (text: string) => void;
  onGenerate: () => void;
  onRotate: () => void;
  onRemove: () => void;
}

function AuthSection({
  authConfigured,
  authSource,
  generatedKey,
  copied,
  onCopy,
  onGenerate,
  onRotate,
  onRemove,
}: AuthSectionProps) {
  // Env var managed — read-only
  if (authSource === 'env') {
    return (
      <SettingRow label="API Key" description="Set via MCP_API_KEY environment variable">
        <Badge variant="outline">Environment variable</Badge>
      </SettingRow>
    );
  }

  // Just generated — show full key once
  if (generatedKey) {
    return (
      <SettingRow label="API Key" description="Copy this key now — it won't be shown again">
        <div className="flex items-center gap-2">
          <code className="bg-muted max-w-[200px] truncate rounded px-2 py-1 text-xs">
            {generatedKey}
          </code>
          <button
            className="text-muted-foreground hover:text-foreground rounded-sm p-1 transition-colors"
            onClick={() => onCopy(generatedKey)}
            aria-label="Copy API key"
          >
            {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
          </button>
          <Button variant="ghost" size="sm" onClick={onRotate}>
            Rotate
          </Button>
        </div>
      </SettingRow>
    );
  }

  // Key exists in config — show masked
  if (authConfigured && authSource === 'config') {
    return (
      <SettingRow label="API Key" description="Bearer token for MCP authentication">
        <div className="flex items-center gap-2">
          <code className="bg-muted rounded px-2 py-1 text-xs">dork_••••••••</code>
          <Button variant="ghost" size="sm" onClick={onRotate}>
            Rotate
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </SettingRow>
    );
  }

  // No key — offer to generate
  return (
    <SettingRow label="Authentication" description="Protect the MCP endpoint with an API key">
      <Button size="sm" onClick={onGenerate}>
        Generate API Key
      </Button>
    </SettingRow>
  );
}
