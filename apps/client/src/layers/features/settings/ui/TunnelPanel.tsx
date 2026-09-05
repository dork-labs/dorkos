import { AnimatePresence, motion } from 'motion/react';
import { Separator, Switch, Field, FieldLabel } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useSessionId } from '@/layers/entities/session';
import type { TunnelMachine } from '../model/use-tunnel-machine';
import type { TunnelActions } from '../model/use-tunnel-actions';
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

/** Props for {@link TunnelPanel}. */
export interface TunnelPanelProps {
  /** The state machine this panel renders. Owned by the caller. */
  machine: TunnelMachine;
  /** The actions bound to that machine. */
  actions: TunnelActions;
  /** Optional className for the panel's outer stack. */
  className?: string;
}

/**
 * Everything Remote Access shows, minus any chrome around it.
 *
 * Extracted from `TunnelDialog` (DOR-1758) so the same body can be a settings
 * TAB — a control that sits in a list of tabs and looks like a tab has to swap
 * the panel, not open a second modal on top of the first. The dialog survives
 * for the one caller that genuinely wants one: the feature promo card.
 *
 * The machine and its actions are the caller's, not this component's: the dialog
 * gates the machine on its own `open` flag, and the tab is mounted only while it
 * is the visible panel. One owner means one set of toasts and one latency probe,
 * however many surfaces render this.
 */
export function TunnelPanel({ machine, actions, className }: TunnelPanelProps) {
  const [activeSessionId] = useSessionId();

  return (
    <div className={cn('space-y-4', className)}>
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
                  <p className="text-muted-foreground text-xs">Open a secure tunnel via ngrok</p>
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
                {machine.state === 'reconnecting' ? 'Reconnecting…' : 'Remote access is on'}
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
            <TunnelError error={machine.error} onRetry={() => void actions.handleToggle(true)} />
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
  );
}
