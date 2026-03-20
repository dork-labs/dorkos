import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Check, Copy, Link } from 'lucide-react';
import { toast } from 'sonner';
import QRCode from 'react-qr-code';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  Separator,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Field,
  FieldLabel,
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { cn, TIMING, getPlatform } from '@/layers/shared/lib';
import { useSessionId } from '@/layers/entities/session';
import { broadcastTunnelChange } from '@/layers/entities/tunnel';
import { TunnelOnboarding } from './TunnelOnboarding';

type TunnelState = 'off' | 'starting' | 'connected' | 'stopping' | 'error';

const START_TIMEOUT_MS = 15_000;
const STUCK_STATE_TIMEOUT_MS = 30_000;
const LATENCY_INTERVAL_MS = 30_000;

interface TunnelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Map common ngrok errors to actionable messages. */
function friendlyErrorMessage(raw: string): string {
  if (/auth|token|ERR_NGROK_105/i.test(raw)) {
    return 'Check your auth token at dashboard.ngrok.com';
  }
  if (/timeout|ETIMEDOUT/i.test(raw)) {
    return 'Connection timed out. Check your network.';
  }
  if (/limit|ERR_NGROK_108/i.test(raw)) {
    return 'Tunnel limit reached. Free ngrok accounts allow one active tunnel.';
  }
  if (/DNS|NXDOMAIN|ERR_NGROK_332/i.test(raw)) {
    return 'DNS resolution failed. Check your domain configuration.';
  }
  if (/gateway|502|ERR_NGROK_3200/i.test(raw)) {
    return 'Gateway error. The tunnel endpoint is unreachable.';
  }
  if (/upgrade|ERR_NGROK_120/i.test(raw)) {
    return 'Feature requires a paid ngrok plan.';
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return 'Connection refused. Ensure the server is running.';
  }
  return raw;
}

/** Determine quality color from latency. */
function latencyColor(ms: number | null): string {
  if (ms === null) return 'bg-gray-400';
  if (ms < 200) return 'bg-green-500';
  if (ms < 500) return 'bg-amber-400';
  return 'bg-red-500';
}

/** Dialog for managing remote access via ngrok tunnel with QR code sharing. */
export function TunnelDialog({ open, onOpenChange }: TunnelDialogProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [activeSessionId] = useSessionId();
  const { data: serverConfig } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const tunnel = serverConfig?.tunnel;

  const [state, setState] = useState<TunnelState>('off');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedSession, setCopiedSession] = useState(false);
  const [domain, setDomain] = useState('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // Track previous connected state for disconnect/reconnect toasts
  const prevConnectedRef = useRef<boolean | undefined>(undefined);

  // Sync state from server config
  /* eslint-disable react-hooks/set-state-in-effect -- sync local UI state from server tunnel config push */
  useEffect(() => {
    if (tunnel?.connected && tunnel?.url) {
      setState('connected');
      setUrl(tunnel.url);
    } else if (state !== 'starting' && state !== 'stopping') {
      setState('off');
      setUrl(null);
    }
  }, [tunnel?.connected, tunnel?.url, state]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Sync domain from server config
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local domain input from server config
    if (tunnel?.domain) setDomain(tunnel.domain);
  }, [tunnel?.domain]);

  // Disconnect/reconnect toast notifications
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    const isConnected = tunnel?.connected ?? false;
    prevConnectedRef.current = isConnected;

    if (wasConnected === undefined) return;

    if (wasConnected && !isConnected) {
      toast.error('Remote access disconnected', {
        id: 'tunnel-status',
        description: 'Attempting to reconnect...',
      });
    } else if (!wasConnected && isConnected && tunnel?.url) {
      toast.success('Remote access reconnected', {
        id: 'tunnel-status',
        description: tunnel.url,
      });
    }
  }, [tunnel?.connected, tunnel?.url]);

  // Recovery from stuck transitional states
  useEffect(() => {
    if (state !== 'starting' && state !== 'stopping') return;
    const timer = setTimeout(() => {
      if (state === 'starting') {
        setState('error');
        setError('Connection timed out. Please try again.');
      } else if (state === 'stopping') {
        setState('off');
        setUrl(null);
      }
    }, STUCK_STATE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // Latency measurement when connected and dialog is open
  /* eslint-disable react-hooks/set-state-in-effect -- periodic latency measurement via interval */
  useEffect(() => {
    if (state !== 'connected' || !url || !open) {
      setLatencyMs(null);
      return;
    }

    const measure = async () => {
      try {
        const start = performance.now();
        await fetch(`${url}/api/health`, { mode: 'cors', cache: 'no-store' });
        setLatencyMs(Math.round(performance.now() - start));
      } catch {
        setLatencyMs(null);
      }
    };

    measure();
    const interval = setInterval(measure, LATENCY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [state, url, open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleToggle = useCallback(
    async (checked: boolean) => {
      if (checked) {
        setState('starting');
        setError(null);
        const timeout = setTimeout(() => {
          setState('error');
          setError('Connection timed out after 15 seconds');
        }, START_TIMEOUT_MS);

        try {
          const result = await transport.startTunnel();
          clearTimeout(timeout);
          setState('connected');
          setUrl(result.url);
          queryClient.invalidateQueries({ queryKey: ['config'] });
          broadcastTunnelChange();
        } catch (err) {
          clearTimeout(timeout);
          setState('error');
          setError(err instanceof Error ? err.message : 'Failed to start tunnel');
        }
      } else {
        setState('stopping');
        setError(null);
        try {
          await transport.stopTunnel();
          setState('off');
          setUrl(null);
          queryClient.invalidateQueries({ queryKey: ['config'] });
          broadcastTunnelChange();
        } catch (err) {
          setState('connected');
          setError(err instanceof Error ? err.message : 'Failed to stop tunnel');
        }
      }
    },
    [transport, queryClient]
  );

  const handleSaveToken = useCallback(async () => {
    setTokenError(null);
    try {
      await transport.updateConfig({ tunnel: { authtoken: authToken } });
      setAuthToken('');
      setShowTokenInput(false);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {
      setTokenError('Could not save token. Try again.');
    }
  }, [authToken, queryClient, transport]);

  const handleSaveDomain = useCallback(async () => {
    try {
      await transport.updateConfig({ tunnel: { domain: domain.trim() || null } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {
      // Silently fail — domain will be re-synced from config
    }
  }, [domain, queryClient, transport]);

  const handleCopyUrl = useCallback(() => {
    if (url) {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
    }
  }, [url]);

  const handleCopySessionLink = useCallback(() => {
    if (url && activeSessionId) {
      navigator.clipboard.writeText(`${url}?session=${activeSessionId}`);
      setCopiedSession(true);
      setTimeout(() => setCopiedSession(false), TIMING.COPY_FEEDBACK_MS);
    }
  }, [url, activeSessionId]);

  // Tunnel is not supported in embedded mode (Obsidian)
  if (getPlatform().isEmbedded) return null;

  const isTransitioning = state === 'starting' || state === 'stopping';
  const isChecked = state === 'connected' || state === 'starting' || state === 'stopping';

  const dotColor = {
    off: 'bg-gray-400',
    starting: 'bg-amber-400',
    connected: 'bg-green-500',
    stopping: 'bg-gray-400',
    error: 'bg-red-500',
  }[state];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-medium">
            <span
              className={cn(
                'inline-block size-2 rounded-full',
                dotColor,
                (state === 'starting' || state === 'stopping') && 'animate-pulse'
              )}
            />
            Remote Access
          </ResponsiveDialogTitle>
          {state === 'off' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Access DorkOS from any device, any browser.
            </ResponsiveDialogDescription>
          )}
          {state === 'starting' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Establishing connection...
            </ResponsiveDialogDescription>
          )}
          {state === 'stopping' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Disconnecting...
            </ResponsiveDialogDescription>
          )}
        </ResponsiveDialogHeader>

        <div className="space-y-4 px-4 pb-4">
          {/* Onboarding — shown when no token configured */}
          {state === 'off' && tunnel && !tunnel.tokenConfigured && <TunnelOnboarding />}

          {/* Auth token section — hidden when connected */}
          {state !== 'connected' && tunnel && (
            <>
              {!tunnel.tokenConfigured || showTokenInput ? (
                <div className="space-y-2">
                  <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                    Auth Token
                  </span>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      placeholder="Paste token here"
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                      className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex-1 rounded-md border px-3 py-1.5 text-sm shadow-sm outline-none focus-visible:ring-1"
                    />
                    <button
                      onClick={handleSaveToken}
                      disabled={!authToken.trim()}
                      className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                  {tokenError && <p className="text-destructive text-xs">{tokenError}</p>}
                  {!tunnel.tokenConfigured && (
                    <p className="text-muted-foreground text-xs">
                      Need a token?{' '}
                      <a
                        href="https://dashboard.ngrok.com/signup"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
                      >
                        Sign up at ngrok.com
                        <ArrowUpRight className="size-3" />
                      </a>
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-sm">
                    Auth token saved
                    <Check className="ml-1 inline size-3.5 text-green-500" />
                  </span>
                  <button
                    onClick={() => setShowTokenInput(true)}
                    className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2 transition-colors"
                  >
                    Change
                  </button>
                </div>
              )}
            </>
          )}

          {/* Custom domain field — visible when token is configured */}
          {tunnel?.tokenConfigured && state !== 'connected' && state !== 'stopping' && (
            <div className="space-y-2">
              <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                Custom Domain
              </span>
              <input
                type="text"
                placeholder="e.g. my-dorkos.ngrok-free.app"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                onBlur={handleSaveDomain}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveDomain()}
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-1.5 text-sm shadow-sm outline-none focus-visible:ring-1"
              />
              <p className="text-muted-foreground text-xs">
                <a
                  href="https://dashboard.ngrok.com/domains"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
                >
                  Get a free static domain
                  <ArrowUpRight className="size-3" />
                </a>
                {' — '}same URL every restart, reusable QR codes, persistent bookmarks.
              </p>
            </div>
          )}

          {/* Connected/stopping state — QR hero */}
          {(state === 'connected' || state === 'stopping') && url && (
            <div className="space-y-3">
              <div className="flex justify-center rounded-lg bg-white p-3">
                <QRCode value={url} size={200} level="M" />
              </div>
              <div className="flex items-center gap-2">
                {state === 'connected' && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          'inline-block size-2 shrink-0 rounded-full',
                          latencyColor(latencyMs)
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {latencyMs !== null ? `${latencyMs}ms` : 'Measuring...'}
                    </TooltipContent>
                  </Tooltip>
                )}
                <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
                  {url}
                </span>
                <button
                  onClick={handleCopyUrl}
                  className="border-input hover:bg-accent inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-transparent px-2.5 py-1 text-xs font-medium shadow-sm transition-colors"
                >
                  {copied ? (
                    <>
                      <Check className="size-3" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="size-3" />
                      Copy
                    </>
                  )}
                </button>
              </div>
              {/* Session sharing link */}
              {state === 'connected' && activeSessionId && (
                <button
                  onClick={handleCopySessionLink}
                  className="border-input hover:bg-accent inline-flex w-full items-center justify-center gap-1.5 rounded-md border bg-transparent px-2.5 py-1 text-xs font-medium shadow-sm transition-colors"
                >
                  {copiedSession ? (
                    <>
                      <Check className="size-3" />
                      Copied session link
                    </>
                  ) : (
                    <>
                      <Link className="size-3" />
                      Copy session link
                    </>
                  )}
                </button>
              )}
              <p className="text-muted-foreground text-center text-xs">
                Scan or visit from any device
              </p>
            </div>
          )}

          {/* Error state — structured card */}
          {state === 'error' && error && (
            <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30">
              <p className="text-sm font-medium text-red-800 dark:text-red-200">
                Connection failed
              </p>
              <p className="text-xs text-red-700 dark:text-red-300">
                {friendlyErrorMessage(error)}
              </p>
              <button
                className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
                onClick={() => {
                  setState('off');
                  setError(null);
                }}
              >
                Retry
              </button>
            </div>
          )}

          {/* Separator + toggle always at bottom */}
          <Separator />
          <Field orientation="horizontal" className="items-center justify-between">
            <FieldLabel className="text-sm font-normal">Enable remote access</FieldLabel>
            <Switch checked={isChecked} onCheckedChange={handleToggle} disabled={isTransitioning} />
          </Field>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
