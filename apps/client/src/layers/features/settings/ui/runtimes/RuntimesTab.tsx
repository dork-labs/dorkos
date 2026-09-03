/**
 * Settings → Runtimes: one card per runtime, then the two things that are true
 * of the whole fleet.
 *
 * The page is a status board (design §1, §4). Every setting that belongs to a
 * runtime lives on that runtime's card — including which runtime new
 * conversations start on, which used to be a dropdown and is now a state a card
 * is in. Nothing Claude-specific survives at tab level; the accounts panel that
 * sat at the bottom of the page is a section the Claude Code card declares.
 *
 * Two responsibilities are deliberately NOT delegated to the cards:
 *
 * - **The default runtime is written here.** `runtimes.default` is one setting
 *   every card can change, and one writer for it means two cards clicked in
 *   quick succession cannot race each other.
 * - **Trust is written here too**, through the single {@link useTrustStopWrites}
 *   call and the single {@link AutonomyConfirmDialog} below. Consent is one
 *   contract with the server — it refuses a Full-autonomy write without an
 *   acknowledgement, and the ack rides the same request — so two dialogs on one
 *   screen would be two contracts that could drift.
 *
 * @module features/settings/ui/runtimes/RuntimesTab
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { cn } from '@/layers/shared/lib';
import { configKeys, useConfig, useUpdateConfig } from '@/layers/entities/config';
import {
  getRuntimeDescriptor,
  listRuntimeTypes,
  useRuntimeCapabilities,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
// UI composition across sibling features, which the layer rule allows: the door
// into Full autonomy is one dialog and one contract, and Settings asks the same
// question the session dial asks rather than a second version of it.
import { AutonomyConfirmDialog } from '@/layers/features/status';
import { useTrustStopWrites } from '../../model/use-trust-stop-writes';
import { ExecutionExceptionsStrip } from './ExecutionExceptionsStrip';
import { RuntimeCard } from './RuntimeCard';
import { GlobalTrustRow, type GlobalTrustRowRuntime } from './GlobalTrustRow';

/** Turn a failed config write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Could not save that. Try again.';
}

/**
 * The runtimes this machine can run, what each one starts with, and where they
 * all stop for you.
 */
export function RuntimesTab() {
  const requirementsQuery = useRuntimeRequirements();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const trust = useTrustStopWrites();
  const reducedMotion = useReducedMotion();
  const [defaultError, setDefaultError] = useState<string | null>(null);

  const types = listRuntimeTypes(capabilityMap ? Object.keys(capabilityMap.capabilities) : []);

  const defaults = config?.executionDefaults;
  const defaultRuntime = defaults?.runtime ?? 'claude-code';
  const perRuntime = defaults?.perRuntime ?? [];

  // What a stored `null` actually means today: the default runtime's own
  // starting mode, read from its profile. Resolved once here so the row and
  // every card agree on what "the global setting" resolves to.
  const defaultRuntimeModes = capabilityMap?.capabilities[defaultRuntime]?.permissionModes;
  const runtimeDefaultStop: PermissionStop =
    defaultRuntimeModes?.values?.find((mode) => mode.id === defaultRuntimeModes.default)?.stop ??
    'ask';
  const globalStop = defaults?.trustStop ?? runtimeDefaultStop;

  /**
   * Point new conversations at a runtime.
   *
   * Invalidates the `configKeys.all` PREFIX, not one key: the status bar, the
   * sidebar badges and `useFeatureEnabled` read config off a broader key set,
   * and the server applies the default live, so every reader has to move with
   * the write. The key comes from the entity's factory rather than a literal,
   * so the prefix is spelled once for every writer on this tab.
   */
  function makeDefault(type: string) {
    setDefaultError(null);
    updateConfig.mutate(
      { runtimes: { default: type } },
      {
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: configKeys.all }),
        onError: (err) => setDefaultError(describeWriteFailure(err)),
      }
    );
  }

  /** Every runtime with a stored entry, as the standing-autonomy note needs it. */
  const trustRuntimes: GlobalTrustRowRuntime[] = perRuntime.map((entry) => ({
    runtime: entry.runtime,
    label: getRuntimeDescriptor(entry.runtime).label,
    stop: entry.trustStop,
  }));

  // One line for either write, because a person who just clicked something wants
  // the answer where they clicked, not two error slots that can both be full.
  const writeError = defaultError ?? trust.writeError;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        {/* The word "runtime" is everywhere on this tab and nowhere else in
            the product — onboarding names Claude Code, Codex and OpenCode
            directly and never says it. One sentence at the top is what makes
            the rest of the tab readable (DOR-1754). */}
        <p className="text-muted-foreground text-sm">
          Runtimes are the AI tools that do the work. Connect the ones you use, and set what each
          one starts a conversation with.
        </p>
        {/* A maintenance action, not a primary one (design §1): the labeled
            "Check again" row became this. Icon-only, so it says its name to a
            screen reader rather than nothing — and that name says "runtimes",
            never "connections", because the language plan's §D2 (shipped as
            DOR-855) reserves that word for the Connections page and this button
            re-probes the runtimes themselves. */}
        <button
          type="button"
          onClick={() => void requirementsQuery.refetch()}
          disabled={requirementsQuery.isFetching}
          aria-label="Check runtimes again"
          title="Check again"
          className="focus-ring text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-1 transition-colors disabled:opacity-50"
          data-testid="runtimes-recheck"
        >
          <RefreshCw
            className={cn(
              'size-3.5',
              requirementsQuery.isFetching && !reducedMotion && 'animate-spin'
            )}
          />
        </button>
      </div>

      <div className="space-y-3">
        {types.map((type) => (
          <RuntimeCard
            key={type}
            type={type}
            isDefault={type === defaultRuntime}
            trustStop={perRuntime.find((entry) => entry.runtime === type)?.trustStop ?? null}
            globalStop={globalStop}
            onChangeTrustStop={(stop) => trust.changeTrustStop(type, stop)}
            onMakeDefault={() => makeDefault(type)}
          />
        ))}
      </div>

      {writeError && (
        <p
          className="text-destructive flex items-start gap-1.5 text-xs"
          data-testid="runtimes-tab-error"
        >
          <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
          <span>{writeError}</span>
        </p>
      )}

      <GlobalTrustRow
        stop={defaults?.trustStop ?? null}
        effectiveStop={runtimeDefaultStop}
        runtimes={trustRuntimes}
        onChange={(stop) => trust.changeTrustStop(null, stop)}
        onChangeRuntime={(runtime, stop) => trust.changeTrustStop(runtime, stop)}
      />

      <ExecutionExceptionsStrip />

      {/* The door, at set-time, once for the whole tab. No "don't show this
          again" checkbox: agreeing HERE is itself the standing record — the
          server requires one for this write, and offering the choice would make
          it look optional when the setting cannot exist without it. */}
      <AutonomyConfirmDialog
        descriptor={trust.pendingAutonomy?.descriptor ?? null}
        canRemember={false}
        consentNote="Every new session will start here, and DorkOS will remember that you have read this."
        onCancel={trust.cancelAutonomy}
        onConfirm={trust.confirmAutonomy}
      />
    </div>
  );
}
