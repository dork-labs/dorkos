import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  Separator,
  Switch,
  Field,
  FieldLabel,
} from '@/layers/shared/ui';
import { useTransport, useIsMobile } from '@/layers/shared/model';
import { cn, getPlatform } from '@/layers/shared/lib';
import { useSessionId } from '@/layers/entities/session';
import { broadcastTunnelChange } from '@/layers/entities/tunnel';
import { TunnelLanding } from './TunnelLanding';
import { TunnelSetup } from './TunnelSetup';
import { TunnelSettings } from './TunnelSettings';
import { TunnelConnecting } from './TunnelConnecting';
import { TunnelConnected } from './TunnelConnected';
import { TunnelError } from './TunnelError';
import { TunnelSecurity } from './TunnelSecurity';

type TunnelState = 'off' | 'starting' | 'connected' | 'stopping' | 'error';
type ViewState = 'landing' | 'setup' | 'ready' | 'connecting' | 'connected' | 'error';

const START_TIMEOUT_MS = 15_000;
const STUCK_STATE_TIMEOUT_MS = 30_000;
const LATENCY_INTERVAL_MS = 30_000;

/** Module-scope animation variants for view crossfades. */
const viewVariants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
} as const;

/** Transition config for view crossfades. */
const viewTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

interface TunnelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Derive which view to show based on tunnel config, state, and user navigation. */
function deriveViewState(
  tokenConfigured: boolean,
  showSetup: boolean,
  tunnelState: TunnelState
): ViewState {
  if (!tokenConfigured && !showSetup) return 'landing';
  if (!tokenConfigured && showSetup) return 'setup';
  if (showSetup) return 'setup';
  if (tunnelState === 'error') return 'error';
  if (tunnelState === 'starting') return 'connecting';
  if (tunnelState === 'connected' || tunnelState === 'stopping') return 'connected';
  return 'ready';
}

/** State machine shell for the Remote Access dialog. Delegates rendering to focused sub-components. */
export function TunnelDialog({ open, onOpenChange }: TunnelDialogProps) {
  const transport = useTransport();
  const isDesktop = !useIsMobile();
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
  const [showSetup, setShowSetup] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [domain, setDomain] = useState('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [passcodeEnabled, setPasscodeEnabled] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState('');

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local domain input from server config
    if (tunnel?.domain) setDomain(tunnel.domain);
  }, [tunnel?.domain]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local passcode toggle from server config
    if (tunnel?.passcodeEnabled !== undefined) setPasscodeEnabled(tunnel.passcodeEnabled);
  }, [tunnel?.passcodeEnabled]);

  // Reset showSetup when token gets configured
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset setup nav when token saves
    if (tunnel?.tokenConfigured) setShowSetup(false);
  }, [tunnel?.tokenConfigured]);

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
      setShowSetup(false);
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

  const handlePasscodeToggle = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        try {
          await transport.setTunnelPasscode({ enabled: false });
          setPasscodeEnabled(false);
          setPasscodeInput('');
          queryClient.invalidateQueries({ queryKey: ['config'] });
          broadcastTunnelChange();
        } catch {
          toast.error('Failed to disable passcode');
        }
      } else {
        setPasscodeEnabled(true);
      }
    },
    [transport, queryClient]
  );

  const handleSavePasscode = useCallback(async () => {
    try {
      await transport.setTunnelPasscode({ passcode: passcodeInput, enabled: true });
      setPasscodeInput('');
      queryClient.invalidateQueries({ queryKey: ['config'] });
      broadcastTunnelChange();
    } catch {
      toast.error('Failed to save passcode');
    }
  }, [passcodeInput, transport, queryClient]);

  if (getPlatform().isEmbedded) return null;

  const tokenConfigured = !!tunnel?.tokenConfigured;
  const viewState = deriveViewState(tokenConfigured, showSetup, state);
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
      <ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-md')}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-medium">
            <span
              className={cn(
                'inline-block size-2 rounded-full',
                dotColor,
                isTransitioning && 'animate-pulse'
              )}
            />
            Remote Access
          </ResponsiveDialogTitle>
          {viewState === 'landing' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Access DorkOS from any device, any browser.
            </ResponsiveDialogDescription>
          )}
          {viewState === 'connecting' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Establishing connection...
            </ResponsiveDialogDescription>
          )}
        </ResponsiveDialogHeader>

        <div className="space-y-4 overflow-y-auto px-4 pb-4">
          {/* View router — AnimatePresence crossfades between states */}
          <AnimatePresence mode="wait">
            {viewState === 'landing' && (
              <motion.div
                key="landing"
                variants={viewVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={viewTransition}
              >
                <TunnelLanding onGetStarted={() => setShowSetup(true)} />
              </motion.div>
            )}

            {viewState === 'setup' && (
              <motion.div
                key="setup"
                variants={viewVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={viewTransition}
              >
                <TunnelSetup
                  authToken={authToken}
                  tokenError={tokenError}
                  onAuthTokenChange={setAuthToken}
                  onSaveToken={handleSaveToken}
                />
              </motion.div>
            )}

            {viewState === 'ready' && (
              <motion.div
                key="ready"
                variants={viewVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={viewTransition}
              >
                {/* Hero toggle card — the primary action, prominent at top */}
                <div
                  className={cn(
                    'rounded-lg border p-4 transition-colors duration-300',
                    'border-border bg-muted/30'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Enable remote access</p>
                      <p className="text-muted-foreground text-xs">
                        Open a secure tunnel via ngrok
                      </p>
                    </div>
                    <Switch checked={false} onCheckedChange={handleToggle} />
                  </div>
                </div>
              </motion.div>
            )}

            {viewState === 'connecting' && (
              <motion.div
                key="connecting"
                variants={viewVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={viewTransition}
              >
                <TunnelConnecting />
              </motion.div>
            )}

            {viewState === 'connected' && url && (
              <motion.div
                key="connected"
                variants={viewVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={viewTransition}
              >
                <TunnelConnected
                  url={url}
                  activeSessionId={activeSessionId}
                  latencyMs={latencyMs}
                />

                {/* Inline toggle — demoted to simple text when connected */}
                <div className="mt-4 flex items-center justify-between">
                  <p className="text-muted-foreground text-sm">Remote access is on</p>
                  <Switch
                    checked={isChecked}
                    onCheckedChange={handleToggle}
                    disabled={isTransitioning}
                  />
                </div>
              </motion.div>
            )}

            {viewState === 'error' && error && (
              <motion.div
                key="error"
                variants={viewVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={viewTransition}
              >
                <TunnelError
                  error={error}
                  onRetry={() => {
                    setState('off');
                    setError(null);
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Security indicator — always visible when token configured, not in setup/landing */}
          {tokenConfigured && viewState !== 'setup' && viewState !== 'landing' && (
            <TunnelSecurity
              passcodeEnabled={passcodeEnabled}
              passcodeAlreadySet={tunnel?.passcodeEnabled ?? false}
              passcodeInput={passcodeInput}
              onPasscodeToggle={handlePasscodeToggle}
              onPasscodeInputChange={setPasscodeInput}
              onPasscodeSave={handleSavePasscode}
            />
          )}

          {/* Collapsible settings — always accessible when token is configured */}
          {tokenConfigured && viewState !== 'setup' && viewState !== 'landing' && (
            <>
              <Separator />
              <TunnelSettings
                authToken={authToken}
                tokenError={tokenError}
                showTokenInput={showTokenInput}
                onAuthTokenChange={setAuthToken}
                onSaveToken={handleSaveToken}
                onShowTokenInput={() => setShowTokenInput(true)}
                domain={domain}
                onDomainChange={setDomain}
                onDomainSave={handleSaveDomain}
              />
            </>
          )}

          {/* Bottom toggle — only for states without an inline toggle */}
          {viewState !== 'connected' && viewState !== 'landing' && viewState !== 'ready' && (
            <>
              <Separator />
              <Field
                orientation="horizontal"
                className={cn(
                  'items-center justify-between rounded-lg border px-3 py-2 transition-colors duration-300',
                  state === 'starting' && 'border-amber-400/40',
                  state === 'stopping' && 'border-amber-400/20',
                  state === 'error' && 'border-destructive/40',
                  state === 'off' && 'border-transparent'
                )}
              >
                <FieldLabel className="text-sm font-normal">Enable remote access</FieldLabel>
                <Switch
                  checked={isChecked}
                  onCheckedChange={handleToggle}
                  disabled={isTransitioning}
                />
              </Field>
            </>
          )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
