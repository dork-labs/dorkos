import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import type { ServerConfig } from '@dorkos/shared/types';
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FieldCard,
  FieldCardContent,
  Switch,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { ApiKeySection } from './ApiKeySection';
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
 * toggle, API key lifecycle, rate limiting, per-client setup instructions, and
 * a duplicate-tool collision warning.
 */
export function ExternalMcpCard({ mcp }: ExternalMcpCardProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

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
            <ApiKeySection
              authConfigured={mcp.authConfigured}
              authSource={mcp.authSource}
              generatedKey={generatedKey}
              keyError={keyError}
              onGenerate={handleGenerateKey}
              onRotate={handleRotateKey}
              onRemove={handleRemoveKey}
            />
            <RateLimitSection rateLimit={mcp.rateLimit} onUpdate={handleUpdateRateLimit} />
            <SetupInstructions endpoint={mcp.endpoint} apiKey={generatedKey} />
          </FieldCardContent>
        </CollapsibleContent>
      </Collapsible>
    </FieldCard>
  );
}
