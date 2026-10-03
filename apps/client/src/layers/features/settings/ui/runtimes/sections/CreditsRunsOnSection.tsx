/**
 * The `credits-runs-on` settings section: what a runtime with no account list
 * of its own (Codex, OpenCode) runs on — its own sign-in, or DorkOS credits
 * (ADR 261001-000811).
 *
 * A view onto the runtime's one recorded credits choice, the same record "Use
 * credits for" switches, so the two can never disagree. It draws only while
 * the server reports the runtime as wired for credits and credits can be had
 * here; everywhere else the card is exactly what it was, because a choice
 * nobody can use would be a promise about somebody's money that nothing keeps.
 *
 * @module features/settings/ui/runtimes/sections/CreditsRunsOnSection
 */
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import type { RuntimeCreditsSupport } from '@dorkos/shared/agent-runtime';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { SegmentedControl, SegmentedControlItem } from '@/layers/shared/ui';
import { useCloudCredits, useSetCreditsDefault } from '@/layers/shared/model';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { CREDITS_ACCOUNT_LABEL } from '@/layers/shared/lib';

/** The two values the choice can take. */
type RunsOn = 'own-sign-in' | 'credits';

/**
 * Whether the section draws for a runtime: credits can be had here and the
 * server reports this runtime as wired.
 *
 * @param report - `GET /api/cloud/credits`, or `undefined` while it loads.
 * @param type - The runtime.
 */
export function creditsRunsOnShown(report: CloudCreditsStatus | undefined, type: string): boolean {
  return (
    report?.enabled === true && report.runtimes[type as keyof typeof report.runtimes] === 'wired'
  );
}

/**
 * What the line under the choice says: what a change reaches, in the words of
 * the runtime's declared scope.
 *
 * @param name - The runtime's display name.
 * @param scope - The runtime's declared credits scope, if known.
 * @param chosenByDorkos - Whether DorkOS chose credits on a new link.
 */
export function creditsRunsOnNote(
  name: string,
  scope: RuntimeCreditsSupport['scope'] | undefined,
  chosenByDorkos: boolean
): string {
  const reach =
    scope === 'runtime'
      ? `A change moves every ${name} conversation, and stops anything ${name} is running at that moment.`
      : `A change applies to new ${name} conversations. One already going stays on what it started on.`;
  return chosenByDorkos
    ? `DorkOS chose credits when you linked, because ${name} had no sign-in. ${reach}`
    : reach;
}

/** Props for {@link CreditsRunsOnSectionView}. */
export interface CreditsRunsOnSectionViewProps {
  /** The runtime this section belongs to. */
  type: string;
  /** What the runtime runs on now. */
  runsOn: RunsOn;
  /** Whether DorkOS made the current choice on a new link. */
  chosenByDorkos: boolean;
  /** The runtime's declared credits scope. */
  scope: RuntimeCreditsSupport['scope'] | undefined;
  /** A write is in flight. */
  pending: boolean;
  /** Why the last change did not take, or `null`. */
  failure: string | null;
  /** Record the person's choice. */
  onChange: (next: RunsOn) => void;
}

/** The section as pure props, so the playground can show both states side by side. */
export function CreditsRunsOnSectionView({
  type,
  runsOn,
  chosenByDorkos,
  scope,
  pending,
  failure,
  onChange,
}: CreditsRunsOnSectionViewProps) {
  const name = runtimeDisplayName(type);
  return (
    <section
      className="bg-muted/30 space-y-3 rounded-lg border p-3"
      data-testid="credits-runs-on-section"
    >
      {/* h3: the runtime card's sections sit under the Settings dialog's h2. */}
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Runs on
      </h3>
      <SegmentedControl
        aria-label={`What ${name} runs on`}
        className="w-full"
        value={runsOn}
        disabled={pending}
        onValueChange={(next) => onChange(next as RunsOn)}
      >
        <SegmentedControlItem value="own-sign-in">
          <span className="truncate">Your {name} sign-in</span>
        </SegmentedControlItem>
        <SegmentedControlItem value="credits">
          <span className="truncate">{CREDITS_ACCOUNT_LABEL}</span>
        </SegmentedControlItem>
      </SegmentedControl>
      <p className="text-muted-foreground text-xs" data-testid="credits-runs-on-note">
        {creditsRunsOnNote(name, scope, chosenByDorkos)}
      </p>
      {failure !== null && (
        <p className="text-destructive text-xs" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}

/**
 * The container: reads the credits report and the runtime's declared scope,
 * and writes the person's choice through the one route that records it.
 *
 * @param props - The runtime whose card this section sits in.
 * @param props.type - The runtime type.
 */
export function CreditsRunsOnSection({ type }: { type: string }) {
  const { data } = useCloudCredits();
  const setDefault = useSetCreditsDefault();
  const scope = useCapabilitiesForRuntime(type)?.credits?.scope;
  if (!creditsRunsOnShown(data, type)) return null;
  const choice = data?.defaults?.[type];
  const runsOn: RunsOn = choice?.runsOn === 'credits' ? 'credits' : 'own-sign-in';
  return (
    <CreditsRunsOnSectionView
      type={type}
      runsOn={runsOn}
      chosenByDorkos={runsOn === 'credits' && choice?.chosenBy === 'default'}
      scope={scope}
      pending={setDefault.isPending}
      failure={setDefault.isError ? 'Couldn’t change that. Try again in a moment.' : null}
      onChange={(next) => {
        if (next !== runsOn) setDefault.mutate({ runtime: type, useCredits: next === 'credits' });
      }}
    />
  );
}
