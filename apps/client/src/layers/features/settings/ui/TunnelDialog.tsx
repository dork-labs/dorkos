import { useState, useEffect, useCallback } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import QRCode from 'react-qr-code';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  Separator,
  Switch,
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { cn, TIMING } from '@/layers/shared/lib';

type TunnelState = 'off' | 'starting' | 'connected' | 'stopping' | 'error';

const START_TIMEOUT_MS = 15_000;

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
  return raw;
}

/** Dialog for managing remote access via ngrok tunnel with QR code sharing. */
export function TunnelDialog({ open, onOpenChange }: TunnelDialogProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
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

  // Sync state from server config
  useEffect(() => {
    if (tunnel?.connected && tunnel?.url) {
      setState('connected');
      setUrl(tunnel.url);
    } else if (state !== 'starting' && state !== 'stopping') {
      setState('off');
      setUrl(null);
    }
  }, [tunnel?.connected, tunnel?.url]);

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
        } catch (err) {
          clearTimeout(timeout);
          setState('error');
          setError(err instanceof Error ? err.message : 'Failed to start tunnel');
        }
      } else {
        setState('off');
        setUrl(null);
        setError(null);
        try {
          await transport.stopTunnel();
          queryClient.invalidateQueries({ queryKey: ['config'] });
        } catch (err) {
          setState('error');
          setError(err instanceof Error ? err.message : 'Failed to stop tunnel');
        }
      }
    },
    [transport, queryClient],
  );

  const handleSaveToken = useCallback(async () => {
    setTokenError(null);
    try {
      await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnel: { authtoken: authToken } }),
      });
      setAuthToken('');
      setShowTokenInput(false);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {
      setTokenError('Could not save token. Try again.');
    }
  }, [authToken, queryClient]);

  const handleCopyUrl = useCallback(() => {
    if (url) {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
    }
  }, [url]);

  const isTransitioning = state === 'starting' || state === 'stopping';
  const isChecked = state === 'connected' || state === 'starting';

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
                state === 'starting' && 'animate-pulse',
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
        </ResponsiveDialogHeader>

        <div className="space-y-4 px-4 pb-4">
          {/* Auth token section — hidden when connected */}
          {state !== 'connected' && tunnel && (
            <>
              {!tunnel.tokenConfigured || showTokenInput ? (
                <div className="space-y-2">
                  <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
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

          {/* Connected state — QR hero */}
          {state === 'connected' && url && (
            <div className="space-y-3">
              <div className="flex justify-center rounded-lg bg-white p-3">
                <QRCode value={url} size={200} level="M" />
              </div>
              <div className="flex items-center gap-2">
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
          <div className="flex items-center justify-between">
            <span className="text-sm">Enable remote access</span>
            <Switch checked={isChecked} onCheckedChange={handleToggle} disabled={isTransitioning} />
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
