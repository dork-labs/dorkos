import { Check, CircleAlert, RefreshCw } from 'lucide-react';
import type { DependencyCheck, SystemRequirements } from '@dorkos/shared/agent-runtime';
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { RUNTIME_DESCRIPTORS, getRuntimeDescriptor } from '../config/runtime-descriptors';
import { useRuntimeCapabilities } from '../model/use-runtime-capabilities';
import { useRuntimeRequirements, isRuntimeReady } from '../model/use-runtime-requirements';
import { DependencyInstallHint } from './DependencyInstallHint';

interface RuntimeSetupPanelProps {
  /** Scope to one runtime; `undefined` renders the "Add a runtime" overview. */
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
 * "Add a runtime" overview lists every addable known runtime (descriptors
 * with a `setup` hint) plus any registered runtime whose checks fail — a
 * stable list that does not reshuffle when a recheck flips a state.
 */
function selectTargetRuntimes(
  runtime: string | undefined,
  requirements: SystemRequirements | undefined,
  registeredTypes: string[]
): string[] {
  if (runtime) return [runtime];
  const addable = Object.values(RUNTIME_DESCRIPTORS)
    .filter((d) => d.setup)
    .map((d) => d.type);
  const unsatisfied = registeredTypes.filter((t) => !isRuntimeReady(requirements, t));
  return [...new Set([...unsatisfied, ...addable])];
}

/**
 * Setup guidance for one or more runtimes: per-dependency status with
 * copyable install/auth commands and a "Check again" action.
 *
 * Presentational — all data arrives via props so the dev playground can
 * render every state. {@link RuntimeSetupDialog} wires the live hooks.
 */
export function RuntimeSetupPanel({
  runtime,
  requirements,
  registeredTypes = [],
  onRecheck,
  isRechecking = false,
}: RuntimeSetupPanelProps) {
  const targets = selectTargetRuntimes(runtime, requirements, registeredTypes);

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
          <p className="text-muted-foreground text-xs">
            Runtimes become selectable once their checks pass.
          </p>
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

/** One runtime's setup section: identity header, state, and guidance. */
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
  const ready = registered && isRuntimeReady(requirements, type);

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
        {ready ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
            <Check className="size-3.5" /> Ready
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-amber-500">
            <CircleAlert className="size-3.5" /> Needs setup
          </span>
        )}
      </div>

      {entry ? (
        <div className="mt-3 space-y-3">
          {entry.dependencies.map((dep) => (
            <DependencyRow key={dep.name} dep={dep} />
          ))}
        </div>
      ) : (
        // No server-side check data — the runtime is not registered with this
        // server (or checks are still loading). Fall back to the descriptor's
        // static guidance so the panel is never a dead end.
        <div className="mt-3 space-y-3">
          {registered ? (
            <p className="text-muted-foreground text-xs">Checking dependencies...</p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Not registered with this server. Install the CLI below, then enable{' '}
              <code className="text-2xs">runtimes.{type}</code> in your DorkOS config.
            </p>
          )}
          {descriptor.setup && (
            <DependencyInstallHint
              command={descriptor.setup.installCommand}
              infoUrl={descriptor.setup.infoUrl}
              copyLabel={`Copy install command for ${descriptor.label}`}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** A single dependency check: status, name, and guidance when unsatisfied. */
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
      {!satisfied && dep.installHint && (
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
  /** Scope to one runtime; `undefined` opens the "Add a runtime" overview. */
  runtime?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The runtime requirements panel, as a dialog (drawer on mobile).
 *
 * Opened from the status-bar runtime picker's needs-setup entries and "Add a
 * runtime" action, and from agent launch surfaces when the target runtime's
 * dependency checks fail. Guidance, not an error: every unsatisfied check
 * comes with a copyable install/auth command and a "Check again" action.
 */
export function RuntimeSetupDialog({ runtime, open, onOpenChange }: RuntimeSetupDialogProps) {
  const requirementsQuery = useRuntimeRequirements();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const descriptor = runtime ? getRuntimeDescriptor(runtime) : null;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {descriptor ? `Set up ${descriptor.label}` : 'Add a runtime'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {descriptor
              ? 'Run these steps in your terminal, then check again.'
              : 'Install a runtime and sign in — DorkOS picks it up on the next check.'}
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
