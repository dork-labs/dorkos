import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, ChevronDown, CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import type { DependencyCheck, SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { RuntimeReadiness as RuntimeConnectState } from '@dorkos/shared/agent-runtime';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { PRIMARY_RUNTIME_TYPES, getRuntimeDescriptor } from '../config/runtime-descriptors';
import { useRuntimeCapabilities } from '../model/use-runtime-capabilities';
import { useRuntimeRequirements, selectRuntimeReadiness } from '../model/use-runtime-requirements';
import { useProvisionOpenCode } from '../model/use-provision-opencode';
import { DependencyInstallHint } from './DependencyInstallHint';

interface RuntimeSetupPanelProps {
  /** Scope to one runtime; `undefined` renders the "Your runtimes" overview. */
  runtime?: string;
  /** Aggregated dependency checks (`undefined` while loading). */
  requirements?: SystemRequirements;
  /** Registered runtime types from the capability map (`undefined` while loading). */
  registeredTypes?: string[];
  /** Re-run the dependency checks. */
  onRecheck?: () => void;
  /** True while a recheck is in flight (spins the button icon). */
  isRechecking?: boolean;
}

/**
 * Which runtimes the panel covers. Scoped mode is just the one runtime; the
 * overview always lists DorkOS's three sibling runtimes (Claude, Codex,
 * OpenCode) so discovery is complete — each renders identically as
 * Ready-or-one-Connect — plus any other registered runtime (a future backend),
 * appended stably so the list never reshuffles when a recheck flips a state.
 */
function selectTargetRuntimes(runtime: string | undefined, registeredTypes: string[]): string[] {
  if (runtime) return [runtime];
  const extras = registeredTypes.filter(
    (t) => !(PRIMARY_RUNTIME_TYPES as readonly string[]).includes(t) && t !== 'test-mode'
  );
  return [...PRIMARY_RUNTIME_TYPES, ...extras];
}

/**
 * Setup surface for one or more runtimes: each renders as **Ready** or a single
 * **Connect** call-to-action — never a raw dependency error on the default
 * path. The binary/CLI detail and copyable install commands live behind a
 * per-runtime Advanced disclosure, collapsed by default.
 *
 * Presentational — all data arrives via props so the dev playground can render
 * every state. {@link RuntimeSetupDialog} wires the live hooks.
 */
export function RuntimeSetupPanel({
  runtime,
  requirements,
  registeredTypes = [],
  onRecheck,
  isRechecking = false,
}: RuntimeSetupPanelProps) {
  const targets = selectTargetRuntimes(runtime, registeredTypes);

  return (
    <div className="space-y-4" data-testid="runtime-setup-panel">
      {targets.map((type) => (
        <RuntimeSection
          key={type}
          type={type}
          requirements={requirements}
          registered={registeredTypes.includes(type)}
        />
      ))}
      {onRecheck && (
        <div className="flex items-center justify-end gap-3 pt-1">
          <p className="text-muted-foreground text-xs">Refresh after connecting.</p>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={onRecheck}
            disabled={isRechecking}
          >
            <RefreshCw className={cn('size-3.5', isRechecking && 'animate-spin')} />
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One runtime, presented as a sibling: identity header with a Ready badge or a
 * single Connect action, and an Advanced disclosure for the underlying checks.
 */
function RuntimeSection({
  type,
  requirements,
  registered,
}: {
  type: string;
  requirements?: SystemRequirements;
  registered: boolean;
}) {
  const descriptor = getRuntimeDescriptor(type);
  const Icon = descriptor.icon;
  const entry = requirements?.runtimes[type];
  const readiness = selectRuntimeReadiness(requirements, type, registered);
  const isReady = readiness.state === 'ready';
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Advanced is offered whenever there is something honest to disclose: live
  // dependency rows (registered) or the descriptor's static setup command
  // (a known runtime this server has not registered).
  const showAdvanced = !!entry || !!descriptor.setup;

  return (
    <section
      className="border-border rounded-xl border p-4"
      data-testid={`runtime-section-${type}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4" />
          <span className="text-sm font-medium">{descriptor.label}</span>
        </div>
        {isReady && (
          <span
            className="inline-flex items-center gap-1 text-xs text-emerald-500"
            data-testid={`runtime-ready-${type}`}
          >
            <Check className="size-3.5" /> Ready
          </span>
        )}
      </div>

      {!isReady && readiness.connect && (
        <div className="mt-3">
          <RuntimeConnectAction
            type={type}
            connect={readiness.connect}
            onShowDetails={() => setAdvancedOpen(true)}
          />
        </div>
      )}

      {showAdvanced && (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-3">
          <CollapsibleTrigger className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors">
            <ChevronDown
              className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-180')}
            />
            Setup details
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-3">
            {entry ? (
              entry.dependencies.map((dep) => <DependencyRow key={dep.name} dep={dep} />)
            ) : (
              <>
                <p className="text-muted-foreground text-xs">
                  Not registered with this server. Install it, then enable{' '}
                  <code className="text-2xs">runtimes.{type}</code> in your DorkOS config.
                </p>
                {descriptor.setup && (
                  <DependencyInstallHint
                    command={descriptor.setup.installCommand}
                    infoUrl={descriptor.setup.infoUrl}
                    copyLabel={`Copy install command for ${descriptor.label}`}
                  />
                )}
              </>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}

/**
 * The single Connect call-to-action for a not-ready runtime.
 *
 * OpenCode's `install` is one-click provisioning (no terminal — ADR-0317); its
 * button streams inline progress and flips the runtime to Ready on success.
 * Every other connect kind (login / provider-picker, or a Codex install this
 * server cannot auto-provision) reveals the Advanced disclosure where the
 * terminal steps live — an honest T0 escape hatch that T1's native connect
 * flows replace.
 */
function RuntimeConnectAction({
  type,
  connect,
  onShowDetails,
}: {
  type: string;
  connect: NonNullable<RuntimeConnectState['connect']>;
  onShowDetails: () => void;
}) {
  const canProvision = type === 'opencode' && connect.kind === 'install';
  if (canProvision) {
    return <OpenCodeProvisionButton label={connect.label} />;
  }
  return (
    <Button size="sm" onClick={onShowDetails}>
      {connect.label}
    </Button>
  );
}

/**
 * OpenCode's one-click Connect: triggers on-demand provisioning, renders inline
 * `motion` progress while installing, and surfaces an honest, retryable error
 * on failure. On success the requirements query is invalidated (by the hook) so
 * the parent section re-renders as Ready and this button unmounts.
 */
function OpenCodeProvisionButton({ label }: { label: string }) {
  const { provision, isPending, isError, errorMessage, progress, result } = useProvisionOpenCode();

  // While installing — or after a successful result, until the parent flips to
  // Ready — show progress instead of a re-clickable button.
  if (isPending || result?.ok) {
    return <ProvisionProgressRow message={progress?.message ?? 'Installing OpenCode…'} />;
  }

  if (isError) {
    return (
      <div className="space-y-2">
        <p className="text-destructive text-xs" role="alert">
          {errorMessage}
        </p>
        <Button size="sm" onClick={provision}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" onClick={provision}>
      {label}
    </Button>
  );
}

/** Inline install-progress row: a spinner plus the latest streamed status line. */
function ProvisionProgressRow({ message }: { message: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2.5"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      data-testid="provision-progress"
    >
      <motion.span
        className="text-muted-foreground inline-flex"
        animate={reducedMotion ? {} : { rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
      >
        <Loader2 className="size-3.5" />
      </motion.span>
      <AnimatePresence mode="wait">
        <motion.span
          key={message}
          className="truncate text-xs"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {message}
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * A single dependency check inside the Advanced disclosure: status, name, and a
 * copyable install/auth command when unsatisfied. This is the Priya-facing
 * detail — CLI/binary vocabulary lives here, never on the default path.
 */
function DependencyRow({ dep }: { dep: DependencyCheck }) {
  const satisfied = dep.status === 'satisfied';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {satisfied ? (
          <Check className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
        )}
        <span className="text-sm">{dep.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {satisfied && dep.version ? `v${dep.version}` : dep.description}
        </span>
      </div>
      {!satisfied && (dep.installHint || dep.infoUrl) && (
        <DependencyInstallHint
          command={dep.installHint}
          infoUrl={dep.infoUrl}
          copyLabel={`Copy install command for ${dep.name}`}
        />
      )}
    </div>
  );
}

interface RuntimeSetupDialogProps {
  /** Scope to one runtime; `undefined` opens the "Your runtimes" overview. */
  runtime?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The runtime setup surface, as a dialog (drawer on mobile).
 *
 * Opened from the status-bar runtime picker's Connect entries and "Add a
 * runtime" action, and from agent launch surfaces when the target runtime is
 * not ready. Each runtime is a sibling: Ready, or a single Connect action.
 * OpenCode connects in one click (inline provisioning); the underlying checks
 * and any terminal steps live behind each runtime's Advanced disclosure.
 */
export function RuntimeSetupDialog({ runtime, open, onOpenChange }: RuntimeSetupDialogProps) {
  const requirementsQuery = useRuntimeRequirements();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const descriptor = runtime ? getRuntimeDescriptor(runtime) : null;
  const readiness = selectRuntimeReadiness(
    requirementsQuery.data,
    runtime ?? '',
    capabilityMap ? runtime !== undefined && runtime in capabilityMap.capabilities : true
  );
  // Only claim "ready" once checks have actually loaded — while loading, lead
  // with the connect-oriented copy (the dialog is usually opened to connect),
  // rather than optimistically asserting readiness we cannot yet substantiate.
  const scopedReady =
    descriptor && requirementsQuery.data !== undefined && readiness.state === 'ready';

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {descriptor ? descriptor.label : 'Your runtimes'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {descriptor
              ? scopedReady
                ? 'This runtime is ready to use.'
                : 'Connect it to start a session.'
              : 'Connect any runtime to start a session with it.'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <RuntimeSetupPanel
            runtime={runtime}
            requirements={requirementsQuery.data}
            registeredTypes={capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined}
            onRecheck={() => void requirementsQuery.refetch()}
            isRechecking={requirementsQuery.isFetching}
          />
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
