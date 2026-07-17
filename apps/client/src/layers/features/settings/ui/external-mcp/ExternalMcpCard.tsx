import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import type { ServerConfig } from '@dorkos/shared/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
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
  /**
   * Whether local login is on (`ServerConfig.auth.enabled`). Needed to tell the
   * two `authSource === 'none'` causes apart: login-on with no personal API keys
   * minted yet (point at Settings → Security) vs the login-off degenerate
   * couldn't-generate-a-token state.
   */
  authEnabled: boolean;
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
export function ExternalMcpCard({ mcp, authEnabled }: ExternalMcpCardProps) {
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

  // The local token never rides GET /api/config (it would leak into caches and
  // any config read); it is fetched on demand via the POST reveal endpoint and
  // held only in component state.
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const handleReveal = useCallback(async () => {
    const { localToken } = await transport.revealMcpLocalToken();
    setRevealedToken(localToken);
  }, [transport]);

  const handleRotate = useCallback(async () => {
    // The rotate response carries the fresh token — show it immediately so the
    // user can paste it into their clients without a second reveal step.
    const { localToken } = await transport.rotateMcpLocalToken();
    setRevealedToken(localToken);
    await invalidateConfig();
  }, [transport, invalidateConfig]);

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
            <McpAuthRow
              authSource={mcp.authSource}
              authEnabled={authEnabled}
              revealedToken={revealedToken}
              onReveal={handleReveal}
              onRotate={handleRotate}
            />
            <RateLimitSection rateLimit={mcp.rateLimit} onUpdate={handleUpdateRateLimit} />
            <SetupInstructions endpoint={mcp.endpoint} apiKey={revealedToken} />
          </FieldCardContent>
        </CollapsibleContent>
      </Collapsible>
    </FieldCard>
  );
}

/** Authentication guidance for the MCP endpoint — reflects the active credential source. */
function McpAuthRow({
  authSource,
  authEnabled,
  revealedToken,
  onReveal,
  onRotate,
}: {
  authSource: McpConfig['authSource'];
  authEnabled: boolean;
  revealedToken: string | null;
  onReveal: () => Promise<void>;
  onRotate: () => Promise<void>;
}) {
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

  if (authSource === 'local-token') {
    return (
      <LocalTokenAuthRow revealedToken={revealedToken} onReveal={onReveal} onRotate={onRotate} />
    );
  }

  // 'none' with login OFF is the degenerate couldn't-generate state. 'none' with
  // login ON just means no personal API key has been minted yet — that gets the
  // same guidance as 'user-keys' below, not a false "couldn't generate" alarm.
  if (authSource === 'none' && !authEnabled) {
    return (
      <SettingRow
        label="Authentication"
        description="Couldn't generate a local token for this instance. External MCP clients won't be able to authenticate until you restart DorkOS or turn on login."
      >
        <Badge variant="outline" className="border-amber-500/50 text-amber-600">
          No token
        </Badge>
      </SettingRow>
    );
  }

  // 'user-keys', or login-on 'none' (no keys minted yet): personal API keys.
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

/**
 * Local-token authentication row (login-off mode): a Reveal action fetches the
 * per-instance token on demand (it never rides the config GET) and shows it in
 * a copyable field, plus a Rotate action guarded by a breaks-existing-clients
 * confirm.
 */
function LocalTokenAuthRow({
  revealedToken,
  onReveal,
  onRotate,
}: {
  revealedToken: string | null;
  onReveal: () => Promise<void>;
  onRotate: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [isRevealing, setIsRevealing] = useState(false);

  async function handleReveal() {
    setIsRevealing(true);
    try {
      await onReveal();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to fetch the local MCP token');
    } finally {
      setIsRevealing(false);
    }
  }

  async function handleConfirmRotate() {
    setIsRotating(true);
    try {
      await onRotate();
      setConfirmOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rotate the local MCP token');
    } finally {
      setIsRotating(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className="text-muted-foreground size-3.5" />
          <p className="text-sm font-medium">Local MCP token</p>
        </div>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm">
              Rotate
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Rotate the local MCP token?</AlertDialogTitle>
              <AlertDialogDescription>
                This makes a new token and turns off the old one right away. Every MCP client you
                already set up will stop working until you paste in the new token. There is no undo.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isRotating}
                onClick={(e) => {
                  // Keep the dialog open until the rotate call resolves so a
                  // failure can surface instead of silently closing.
                  e.preventDefault();
                  void handleConfirmRotate();
                }}
              >
                {isRotating ? 'Rotating…' : 'Rotate token'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="text-muted-foreground text-xs">
        Paste this token into your MCP client as a <code className="font-mono">Bearer</code> token.
        It protects the tools that change things on your machine; read-only checks work without it.
      </p>
      {revealedToken ? (
        <div className="flex items-center gap-1.5">
          <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
            {revealedToken}
          </code>
          <CopyButton value={revealedToken} />
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={handleReveal} disabled={isRevealing}>
          {isRevealing ? 'Revealing…' : 'Reveal token'}
        </Button>
      )}
    </div>
  );
}
