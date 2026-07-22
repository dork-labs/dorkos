import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, ChevronDown, CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import type { DependencyCheck, SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { RuntimeReadiness as RuntimeConnectState } from '@dorkos/shared/agent-runtime';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  InlineCode,
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
import { useProvisionRuntime } from '../model/use-provision-runtime';
import { DependencyInstallHint } from './DependencyInstallHint';
import { CommandTransparencyNote } from './CommandTransparencyNote';

/**
 * The success moment a connect path reports when it lands. The entity renders it
 * as an explicit panel with a Done button; the copy is supplied by the feature so
 * it can be path-aware (a cloud "frontier unlocked" vs a local "models ready"
 * line), keeping OpenCode-specific wording out of the entity.
 */
export interface RuntimeConnectSuccess {
  /** Headline, rendered with a ✓ (e.g. `"OpenCode is connected."`). */
  title: string;
  /** Supporting line beneath the headline; honest and path-aware. */
  body: string;
}

/**
 * Context handed to a feature-supplied connect renderer for a not-ready runtime.
 * The entity owns the two-state shell; the actual terminal-free connect flow
 * (paste-key, delegated login, the OpenCode provider picker) is injected by the
 * `features/runtime-connect` slice so the entity never imports a feature.
 */
export interface RuntimeConnectSlotProps {
  /** Runtime type, e.g. `'codex'`. */
  type: string;
  /** The server's honest connect projection (kind + label) for this runtime. */
  connect: NonNullable<RuntimeConnectState['connect']>;
  /**
   * The currently connected provider id, when the flow is reopened to CHANGE an
   * already-connected runtime (OpenCode's "Change power source"). Lets the
   * provider-agnostic picker label the current source ("Currently: On your
   * computer (Ollama)"). Absent on a first connect.
   */
  currentProvider?: string;
  /**
   * Called by a connect path the instant it succeeds, with the success-moment
   * copy. Injected only when the opener asked for the explicit success panel
   * (`showConnectSuccess`); otherwise omitted, and the path shows its own inline
   * "Connected" confirmation as before. Independent of the requirements
   * ready-flip, so the success moment can render immediately.
   */
  onConnected?: (success: RuntimeConnectSuccess) => void;
}

/**
 * Renders the inline connect flow for a `login` / `provider-picker` runtime.
 *
 * Supplied by `features/runtime-connect`; when absent (dev playground, or the
 * install-only T0 surface) the section falls back to revealing its Advanced
 * disclosure. A pure function type — no feature dependency crosses into the
 * entity layer.
 */
export type RuntimeConnectSlot = (props: RuntimeConnectSlotProps) => ReactNode;

interface RuntimeSetupPanelProps {
  /** Scope to one runtime; `undefined` renders the "Your runtimes" overview. */
  runtime?: string;
  /**
   * Explicit list of runtime types to render, in order — wins over the default
   * "all primaries" overview. Used where the caller has already decided which
   * runtimes belong on the surface (e.g. onboarding showing only the not-yet-ready
   * runtimes under "more agents available"). Ignored when `runtime` is set.
   */
  types?: string[];
  /** Aggregated dependency checks (`undefined` while loading). */
  requirements?: SystemRequirements;
  /** Registered runtime types from the capability map (`undefined` while loading). */
  registeredTypes?: string[];
  /** Re-run the dependency checks. */
  onRecheck?: () => void;
  /** True while a recheck is in flight (spins the button icon). */
  isRechecking?: boolean;
  /**
   * Feature-supplied renderer for the `login` / `provider-picker` connect flows.
   * Omit to fall back to the Advanced-disclosure escape hatch (T0 behaviour).
   */
  renderConnect?: RuntimeConnectSlot;
}

/**
 * Which runtimes the panel covers. Scoped mode is just the one runtime; the
 * overview always lists DorkOS's three sibling runtimes (Claude, Codex,
 * OpenCode) so discovery is complete — each renders identically as
 * Ready-or-one-Connect — plus any other registered runtime (a future backend),
 * appended stably so the list never reshuffles when a recheck flips a state.
 */
function selectTargetRuntimes(
  runtime: string | undefined,
  types: string[] | undefined,
  registeredTypes: string[]
): string[] {
  if (runtime) return [runtime];
  if (types) return types;
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
  types,
  requirements,
  registeredTypes = [],
  onRecheck,
  isRechecking = false,
  renderConnect,
}: RuntimeSetupPanelProps) {
  const targets = selectTargetRuntimes(runtime, types, registeredTypes);

  return (
    <div className="space-y-4" data-testid="runtime-setup-panel">
      {targets.map((type) => (
        <RuntimeSection
          key={type}
          type={type}
          requirements={requirements}
          registered={registeredTypes.includes(type)}
          renderConnect={renderConnect}
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
  renderConnect,
}: {
  type: string;
  requirements?: SystemRequirements;
  registered: boolean;
  renderConnect?: RuntimeConnectSlot;
}) {
  const descriptor = getRuntimeDescriptor(type);
  const Icon = descriptor.icon;
  const entry = requirements?.runtimes[type];
  const readiness = selectRuntimeReadiness(requirements, type, registered);
  const isReady = readiness.state === 'ready';
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [changing, setChanging] = useState(false);

  // A ready, provider-agnostic runtime (OpenCode reports its connected
  // `provider`) can switch power source: the Change affordance reopens the same
  // picker, prefilled with the current source, and runs the normal connect flow
  // (the server is last-write-wins on the provider). Only offered when a connect
  // renderer is wired — the picker lives in the feature layer (spec §9).
  const currentProvider = entry?.provider;
  const canChange = isReady && !!currentProvider && !!renderConnect;

  // The command a one-click install would run — sourced from the live install
  // dependency's hint, falling back to the descriptor's static setup command.
  // Drives the transparency fine print and the manual fallback when a runtime's
  // server has no provision endpoint.
  const installDep = entry?.dependencies.find((d) => d.status !== 'satisfied' && d.installHint);
  const installCommand = installDep?.installHint ?? descriptor.setup?.installCommand;
  const installInfoUrl = installDep?.infoUrl ?? descriptor.setup?.infoUrl;

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
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1 text-xs text-emerald-500"
              data-testid={`runtime-ready-${type}`}
            >
              <Check className="size-3.5" /> Ready
            </span>
            {canChange && !changing && (
              <button
                type="button"
                onClick={() => setChanging(true)}
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 transition-colors hover:underline"
                data-testid={`runtime-change-${type}`}
              >
                Change
              </button>
            )}
          </div>
        )}
      </div>

      {canChange && changing && (
        <div className="mt-3 space-y-2" data-testid={`runtime-change-panel-${type}`}>
          {renderConnect?.({
            type,
            connect: { kind: 'provider-picker', label: 'Change power source' },
            ...(currentProvider ? { currentProvider } : {}),
            // Collapse the change UI the instant the switch lands: the cancel
            // affordance disappears, and the dialog's own success handling
            // (composed onto this slot) takes over — an in-place switch ends in
            // the success panel with Done, exactly like a first connect.
            onConnected: () => setChanging(false),
          })}
          <button
            type="button"
            onClick={() => setChanging(false)}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            data-testid={`runtime-change-cancel-${type}`}
          >
            Keep current source
          </button>
        </div>
      )}

      {!isReady && readiness.connect && (
        <div className="mt-3">
          <RuntimeConnectAction
            type={type}
            connect={readiness.connect}
            renderConnect={renderConnect}
            installCommand={installCommand}
            installInfoUrl={installInfoUrl}
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
                  <InlineCode>runtimes.{type}</InlineCode> in your DorkOS config.
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
 * The `install` kind is one-click provisioning (no terminal — ADR-0317): the
 * button streams inline progress, flips the runtime to Ready on success, and —
 * when the runtime's server exposes no provision endpoint — degrades to the
 * manual install hint rather than a dead end. Muted transparency fine print
 * always states the exact command that would run on the machine.
 *
 * The `login` and `provider-picker` kinds render the feature-supplied
 * {@link RuntimeConnectSlot} inline (Codex/Claude paste-key + delegated login,
 * the OpenCode provider picker). When no slot is injected — the dev playground —
 * the button reveals the Advanced disclosure where the terminal steps live.
 */
function RuntimeConnectAction({
  type,
  connect,
  renderConnect,
  installCommand,
  installInfoUrl,
  onShowDetails,
}: {
  type: string;
  connect: NonNullable<RuntimeConnectState['connect']>;
  renderConnect?: RuntimeConnectSlot;
  installCommand?: string;
  installInfoUrl?: string;
  onShowDetails: () => void;
}) {
  if (connect.kind === 'install') {
    return (
      <RuntimeProvisionButton
        type={type}
        label={connect.label}
        installCommand={installCommand}
        installInfoUrl={installInfoUrl}
      />
    );
  }
  if (renderConnect && (connect.kind === 'login' || connect.kind === 'provider-picker')) {
    return <>{renderConnect({ type, connect })}</>;
  }
  return (
    <Button size="sm" onClick={onShowDetails}>
      {connect.label}
    </Button>
  );
}

/**
 * One-click Connect for an `install` runtime: triggers on-demand provisioning,
 * renders inline `motion` progress while installing, and surfaces an honest,
 * retryable error on failure. On success the requirements query is invalidated
 * (by the hook) so the parent section re-renders as Ready and this button
 * unmounts.
 *
 * Graceful degradation: when the runtime's server has no provision endpoint the
 * install rejects (e.g. HTTP 404), so on error the manual install hint is shown
 * alongside the retry — the user is never stranded on a button that cannot work.
 * The transparency note under the idle button always names the exact command.
 */
function RuntimeProvisionButton({
  type,
  label,
  installCommand,
  installInfoUrl,
}: {
  type: string;
  label: string;
  installCommand?: string;
  installInfoUrl?: string;
}) {
  const descriptor = getRuntimeDescriptor(type);
  const { provision, isPending, isError, errorMessage, progress, result } =
    useProvisionRuntime(type);

  // While installing — or after a successful result, until the parent flips to
  // Ready — show progress instead of a re-clickable button.
  if (isPending || result?.ok) {
    return (
      <ProvisionProgressRow message={progress?.message ?? `Installing ${descriptor.label}…`} />
    );
  }

  if (isError) {
    return (
      <div className="space-y-2">
        <p className="text-destructive text-xs" role="alert">
          {errorMessage}
        </p>
        {installCommand && (
          <>
            <p className="text-muted-foreground text-xs">You can install it yourself instead:</p>
            <DependencyInstallHint
              command={installCommand}
              infoUrl={installInfoUrl}
              copyLabel={`Copy install command for ${descriptor.label}`}
            />
          </>
        )}
        <Button size="sm" onClick={provision}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div>
      <Button size="sm" onClick={provision}>
        {label}
      </Button>
      {installCommand && (
        <CommandTransparencyNote command={installCommand} runtimeLabel={descriptor.label} />
      )}
    </div>
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
      {/* CSS spin (not motion rotate): a repeated animate-to-360 stalls after the
          first turn on re-render, so the spinner looked frozen (DOR-439). */}
      <Loader2
        className={cn('text-muted-foreground size-3.5 shrink-0', !reducedMotion && 'animate-spin')}
      />
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
      {/* Stacked, not inline: the name owns its own line so a long label never
          wraps beside a truncating description. The detail sits below at full
          width and wraps naturally — nothing is clipped out of view. */}
      <div>
        <div className="flex items-center gap-2">
          {satisfied ? (
            <Check className="size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
          )}
          <span className="text-sm">{dep.name}</span>
        </div>
        <p className="text-muted-foreground mt-1 pl-[1.375rem] text-xs">
          {satisfied && dep.version ? `v${dep.version}` : dep.description}
        </p>
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
  /**
   * Feature-supplied renderer for the `login` / `provider-picker` connect flows
   * (from `features/runtime-connect`). Omit for the install-only surface.
   */
  renderConnect?: RuntimeConnectSlot;
  /**
   * Fired once when a SCOPED runtime transitions from not-ready to ready while
   * the dialog is open (the connect just succeeded). Lets the opener continue
   * the flow it was blocked on — select the runtime, or launch the session that
   * was waiting on it — so a connect is never a dead end. Never fires in the
   * unscoped "Your runtimes" overview, nor when the dialog opens on a runtime
   * that is already ready.
   *
   * @param type - The runtime type that just became ready, e.g. `'opencode'`.
   */
  onRuntimeReady?: (type: string) => void;
  /**
   * Show an explicit success panel (with a Done button) when an in-dialog connect
   * path reports success, in place of the path's own inline "Connected"
   * confirmation. When set, the dialog stays open on success so the person sees
   * the success moment and dismisses it with Done — the opener's `onRuntimeReady`
   * must therefore NOT auto-close (it keeps only the runtime handoff). Used by the
   * toolbar runtime chip's connect flow (spec: opencode-connect-overhaul §6).
   */
  showConnectSuccess?: boolean;
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
export function RuntimeSetupDialog({
  runtime,
  open,
  onOpenChange,
  renderConnect,
  onRuntimeReady,
  showConnectSuccess = false,
}: RuntimeSetupDialogProps) {
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
  const readinessLoaded = requirementsQuery.data !== undefined;
  const isScopedReady = descriptor !== null && readinessLoaded && readiness.state === 'ready';

  // Signal the opener when a connect succeeds, so a connect is never a dead end.
  // We cannot fire on every `isScopedReady === true` render: opening the dialog
  // on an already-ready runtime would auto-fire. So we baseline readiness the
  // first time it is actually KNOWN after `open` (no fire), clear it on close,
  // and fire only on a genuine not-ready to ready flip of the SAME runtime (the
  // moment connect turned it Ready). Two guards keep it honest: gating the
  // baseline on `readinessLoaded` stops the initial loading render (readiness
  // unknown, read as not-ready) from looking like a real transition once checks
  // resolve; keying the baseline to `runtime` means a caller that swaps the
  // scoped runtime in place re-baselines instead of firing a stale signal. The
  // unscoped overview (`runtime === undefined`) never fires.
  const baselineRef = useRef<{ runtime: string; ready: boolean } | null>(null);
  useEffect(() => {
    if (!open) {
      baselineRef.current = null;
      return;
    }
    if (runtime === undefined || !readinessLoaded) return;
    const baseline = baselineRef.current;
    baselineRef.current = { runtime, ready: isScopedReady };
    if (baseline !== null && baseline.runtime === runtime && !baseline.ready && isScopedReady) {
      onRuntimeReady?.(runtime);
    }
  }, [open, readinessLoaded, isScopedReady, runtime, onRuntimeReady]);

  // The success moment: a connect path reports its landing via `onConnected`, and
  // the dialog swaps the setup panel for an explicit success panel with a Done
  // button. Independent of the ready-flip above (which drives the runtime
  // handoff), so it renders the instant the connect succeeds. Only wired when the
  // opener asked for it (`showConnectSuccess`); reset whenever the dialog closes.
  const [success, setSuccess] = useState<RuntimeConnectSuccess | null>(null);
  useEffect(() => {
    if (!open) setSuccess(null);
  }, [open]);
  // Compose, never clobber: a slot caller may pass its own `onConnected` (the
  // ready-state Change flow uses it to collapse its UI). When the opener asked
  // for the success panel we run BOTH — the caller's handler and `setSuccess` —
  // so an in-place switch ends in the success panel just like a first connect.
  const wrappedRenderConnect: RuntimeConnectSlot | undefined =
    renderConnect &&
    (showConnectSuccess
      ? (props) =>
          renderConnect({
            ...props,
            onConnected: (success) => {
              props.onConnected?.(success);
              setSuccess(success);
            },
          })
      : renderConnect);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {descriptor ? descriptor.label : 'Your runtimes'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {success
              ? 'Connected.'
              : descriptor
                ? isScopedReady
                  ? 'This runtime is ready to use.'
                  : 'Connect it to start a session.'
                : 'Connect any runtime to start a session with it.'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          {success ? (
            <RuntimeConnectedPanel success={success} onDone={() => onOpenChange(false)} />
          ) : (
            <RuntimeSetupPanel
              runtime={runtime}
              requirements={requirementsQuery.data}
              registeredTypes={capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined}
              onRecheck={() => void requirementsQuery.refetch()}
              isRechecking={requirementsQuery.isFetching}
              renderConnect={wrappedRenderConnect}
            />
          )}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * The explicit success moment shown after an in-dialog connect lands: a check, the
 * feature-supplied headline + body, and a single Done button that closes the
 * dialog. The runtime handoff (selecting the just-connected runtime for the
 * pending session) rides the opener's `onRuntimeReady` in the background — this
 * panel's only job is to make success legible and let the person dismiss it.
 */
function RuntimeConnectedPanel({
  success,
  onDone,
}: {
  success: RuntimeConnectSuccess;
  onDone: () => void;
}) {
  return (
    <div className="space-y-4" data-testid="runtime-connected-panel">
      <div className="flex items-start gap-2.5">
        <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{success.title}</p>
          <p className="text-muted-foreground text-xs leading-relaxed">{success.body}</p>
        </div>
      </div>
      <Button size="sm" className="w-full" onClick={onDone} data-testid="runtime-connected-done">
        Done
      </Button>
    </div>
  );
}
