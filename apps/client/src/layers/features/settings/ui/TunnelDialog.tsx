import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
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
import { useTunnelMachine } from '../model/use-tunnel-machine';
import { useTunnelActions } from '../model/use-tunnel-actions';
import { TunnelLanding } from './TunnelLanding';
import { TunnelSetup } from './TunnelSetup';
import { TunnelSettings } from './TunnelSettings';
import { TunnelConnecting } from './TunnelConnecting';
import { TunnelConnected } from './TunnelConnected';
import { TunnelError } from './TunnelError';

/** Module-scope animation variants for view crossfades. */
const viewVariants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
} as const;

/** Transition config for view crossfades. */
const viewTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

/** Spread on each `<motion.div>` view wrapper to deduplicate identical props. */
const viewMotion = {
  variants: viewVariants,
  initial: 'initial' as const,
  animate: 'animate' as const,
  exit: 'exit' as const,
  transition: viewTransition,
};

interface TunnelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** State machine shell for the Remote Access dialog. Delegates rendering to focused sub-components. */
export function TunnelDialog({ open, onOpenChange }: TunnelDialogProps) {
  const transport = useTransport();
  const isDesktop = !useIsMobile();
  const queryClient = useQueryClient();
  const [activeSessionId] = useSessionId();

  const machine = useTunnelMachine({ open });
  const actions = useTunnelActions({ machine, transport, queryClient });

  if (getPlatform().isEmbedded) return null;

  // The cockpit's own dot vocabulary (`shared/ui/status-dot.ts`), not the raw
  // palette. `-dot` on the amber is load-bearing: it is the variant taken to
  // 3:1 against a light surface, which a coloured dot needs and the fill-tuned
  // `--status-warning` does not meet.
  const dotColor = {
    off: 'bg-muted-foreground/40',
    starting: 'bg-status-warning-dot',
    connected: 'bg-status-success',
    // Amber, like `starting`, and for the same reason: the tunnel is on its way
    // to being reachable, not off and not broken.
    reconnecting: 'bg-status-warning-dot',
    stopping: 'bg-muted-foreground/40',
    error: 'bg-status-error',
  }[machine.state];

  // Pulses while the dialog is waiting on something, which now includes ngrok
  // re-establishing a dropped session — but `isTransitioning` deliberately does
  // NOT, because it also disables the switch.
  const dotPulses = machine.isTransitioning || machine.state === 'reconnecting';

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-md')}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-medium">
            <span
              className={cn(
                'inline-block size-2 rounded-full',
                dotColor,
                dotPulses && 'animate-tasks'
              )}
            />
            Remote Access
          </ResponsiveDialogTitle>
          {machine.viewState === 'landing' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Access DorkOS from any device, any browser.
            </ResponsiveDialogDescription>
          )}
          {machine.viewState === 'connecting' && (
            <ResponsiveDialogDescription className="text-muted-foreground text-xs">
              Connecting...
            </ResponsiveDialogDescription>
          )}
        </ResponsiveDialogHeader>

        <div className="space-y-4 overflow-y-auto px-4 pb-4">
          {/* View router — AnimatePresence crossfades between states */}
          <AnimatePresence mode="wait">
            {machine.viewState === 'landing' && (
              <motion.div key="landing" {...viewMotion}>
                <TunnelLanding onGetStarted={() => machine.setShowSetup(true)} />
              </motion.div>
            )}

            {machine.viewState === 'setup' && (
              <motion.div key="setup" {...viewMotion}>
                <TunnelSetup
                  authToken={machine.authToken}
                  tokenError={machine.tokenError}
                  onAuthTokenChange={machine.setAuthToken}
                  onSaveToken={actions.handleSaveToken}
                />
              </motion.div>
            )}

            {machine.viewState === 'ready' && (
              <motion.div key="ready" {...viewMotion}>
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
                    <Switch checked={false} onCheckedChange={actions.handleToggle} />
                  </div>
                </div>
              </motion.div>
            )}

            {machine.viewState === 'connecting' && (
              <motion.div key="connecting" {...viewMotion}>
                <TunnelConnecting />
              </motion.div>
            )}

            {machine.viewState === 'connected' && machine.url && (
              <motion.div key="connected" {...viewMotion}>
                <TunnelConnected
                  url={machine.url}
                  activeSessionId={activeSessionId}
                  latencyMs={machine.latencyMs}
                />

                {/* Inline toggle — demoted to simple text when connected */}
                <div className="mt-4 flex items-center justify-between">
                  <p className="text-muted-foreground text-sm">
                    {machine.state === 'reconnecting'
                      ? 'Reconnecting\u2026'
                      : 'Remote access is on'}
                  </p>
                  <Switch
                    checked={machine.isChecked}
                    onCheckedChange={actions.handleToggle}
                    disabled={machine.isTransitioning}
                  />
                </div>
              </motion.div>
            )}

            {machine.viewState === 'error' && machine.error && (
              <motion.div key="error" {...viewMotion}>
                {/* Retries, rather than tidying the error away and leaving the
                    person to find the switch again — "Try again" on a failure
                    means try the thing that failed. `startTunnel` clears the
                    error itself on the way in. */}
                <TunnelError
                  error={machine.error}
                  onRetry={() => void actions.handleToggle(true)}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Collapsible settings — always accessible when token is configured */}
          {machine.tokenConfigured &&
            machine.viewState !== 'setup' &&
            machine.viewState !== 'landing' && (
              <>
                <Separator />
                <TunnelSettings
                  authToken={machine.authToken}
                  tokenError={machine.tokenError}
                  tokenConfigured={machine.tokenConfigured}
                  showTokenInput={machine.showTokenInput}
                  onAuthTokenChange={machine.setAuthToken}
                  onSaveToken={actions.handleSaveToken}
                  onShowTokenInput={() => machine.setShowTokenInput(true)}
                  domain={machine.domain}
                  domainError={machine.domainError}
                  onDomainChange={machine.setDomain}
                  onDomainSave={actions.handleSaveDomain}
                />
              </>
            )}

          {/* Bottom toggle — only for states without an inline toggle */}
          {machine.viewState !== 'connected' &&
            machine.viewState !== 'landing' &&
            machine.viewState !== 'ready' && (
              <>
                <Separator />
                <Field
                  orientation="horizontal"
                  className={cn(
                    'items-center justify-between rounded-lg border px-3 py-2 transition-colors duration-300',
                    machine.state === 'starting' && 'border-amber-400/40',
                    machine.state === 'stopping' && 'border-amber-400/20',
                    machine.state === 'error' && 'border-destructive/40',
                    machine.state === 'off' && 'border-transparent'
                  )}
                >
                  <FieldLabel className="text-sm font-normal">Enable remote access</FieldLabel>
                  <Switch
                    checked={machine.isChecked}
                    onCheckedChange={actions.handleToggle}
                    disabled={machine.isTransitioning}
                  />
                </Field>
              </>
            )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
