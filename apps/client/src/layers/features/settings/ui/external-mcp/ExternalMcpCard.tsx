import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, KeyRound } from 'lucide-react';
import type { ServerConfig } from '@dorkos/shared/types';
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FieldCard,
  FieldCardContent,
  SettingRow,
  Switch,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { DuplicateToolWarning } from './DuplicateToolWarning';
import { EndpointRow } from './EndpointRow';
import { RateLimitSection } from './RateLimitSection';
import { SetupInstructions } from './SetupInstructions';

type McpConfig = NonNullable<ServerConfig['mcp']>;

interface ExternalMcpCardProps {
  mcp: McpConfig;
}

/**
 * External MCP Server card for the ToolsTab.
 *
 * Provides a collapsible control surface for the external MCP endpoint: enable/disable
 * toggle, per-user API key guidance, rate limiting, per-client setup instructions, and
 * a duplicate-tool collision warning.
 *
 * MCP clients authenticate with a personal API key (Better Auth `apiKey` plugin),
 * created and revoked in Settings → Security → API keys, or via the `MCP_API_KEY`
 * environment override for headless deployments. This card no longer mints a single
 * global key — key lifecycle lives in the Security section.
 */
export function ExternalMcpCard({ mcp }: ExternalMcpCardProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const invalidateConfig = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['config'] }),
    [queryClient]
  );

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      await transport.updateConfig({ mcp: { enabled, rateLimit: mcp.rateLimit } });
      await invalidateConfig();
    },
    [transport, mcp.rateLimit, invalidateConfig]
  );

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
            <DuplicateToolWarning />
            <EndpointRow endpoint={mcp.endpoint} />
            <McpAuthRow authSource={mcp.authSource} />
            <RateLimitSection rateLimit={mcp.rateLimit} onUpdate={handleUpdateRateLimit} />
            <SetupInstructions endpoint={mcp.endpoint} apiKey={null} />
          </FieldCardContent>
        </CollapsibleContent>
      </Collapsible>
    </FieldCard>
  );
}

/** Authentication guidance for the MCP endpoint — reflects the active credential source. */
function McpAuthRow({ authSource }: { authSource: McpConfig['authSource'] }) {
  if (authSource === 'env') {
    return (
      <SettingRow
        label="Authentication"
        description="Gated by the MCP_API_KEY environment variable"
      >
        <Badge variant="outline">Environment variable</Badge>
      </SettingRow>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <KeyRound className="text-muted-foreground size-3.5" />
        <p className="text-sm font-medium">Authentication</p>
      </div>
      <p className="text-muted-foreground text-xs">
        MCP clients authenticate with a personal API key. Create or revoke keys in Settings →
        Security → API keys, then pass it as a <code className="font-mono">Bearer</code> token.
      </p>
    </div>
  );
}
