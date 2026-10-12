import { useMemo, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import {
  getRuntimeDescriptor,
  PRIMARY_RUNTIME_TYPES,
  runsOnCredits,
  RuntimeSetupPanel,
  selectRuntimeReadiness,
  useRuntimeCapabilities,
  useRuntimeRequirements,
  type RuntimeConnectSlot,
} from '@/layers/entities/runtime';
import { useCloudCredits } from '@/layers/shared/model';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  Spinner,
} from '@/layers/shared/ui';
import {
  chooseDefaultRuntime,
  useOnboardingRuntimeDefault,
} from '../model/use-onboarding-runtime-default';

interface AiAppSignInProps {
  /** Carry on to #team. Offered once one app is signed in. */
  onContinue: () => void;
  /** The AI apps' connect flows, lent by the app shell. */
  renderConnect?: RuntimeConnectSlot;
  /**
   * Pre-baked requirements that bypass the live query, and the default they
   * would pick — Dev Playground only, so nothing writes the developer's own
   * default.
   */
  simulated?: { requirements: SystemRequirements; defaultRuntime?: string };
}

/**
 * "An AI app you sign in to" (spec `one-minute-onboarding` §2.3): the AI apps'
 * own connect cards, for a person who already pays for one.
 *
 * Names are allowed here because the person asked for them. Once one app is
 * signed in, setup picks which one new chats start with, says so, and offers
 * the one tap that changes it (spec `execution-defaults` §7).
 */
export function AiAppSignIn({ onContinue, renderConnect, simulated }: AiAppSignInProps) {
  const query = useRuntimeRequirements();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: credits } = useCloudCredits();
  const requirements = simulated?.requirements ?? query.data;
  const settled = simulated !== undefined || query.isSuccess;

  const registeredTypes = capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined;
  const apps = useMemo(
    () =>
      PRIMARY_RUNTIME_TYPES.filter(
        (type) => requirements?.runtimes[type] !== undefined
      ) as string[],
    [requirements]
  );
  const readyTypes = useMemo(
    () =>
      requirements
        ? apps.filter(
            (type) =>
              selectRuntimeReadiness(requirements, type, true).state === 'ready' ||
              (simulated === undefined && runsOnCredits(credits, type))
          )
        : [],
    [apps, requirements, credits, simulated]
  );

  const live = useOnboardingRuntimeDefault({
    readyTypes,
    settled: settled && simulated === undefined,
    settleToken: query.dataUpdatedAt,
  });
  const [simulatedChoice, setSimulatedChoice] = useState<string | null>(null);
  const defaultRuntime = simulated?.defaultRuntime
    ? {
        runtime: simulatedChoice ?? simulated.defaultRuntime,
        current: simulatedChoice ?? simulated.defaultRuntime,
        choose: setSimulatedChoice,
        error: null,
      }
    : live;

  if (!settled) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Spinner size="xs" />
        Looking for AI apps…
      </p>
    );
  }
  if (simulated === undefined && query.isError) {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-muted-foreground text-sm">Couldn’t check for AI apps.</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const hasReady = readyTypes.length > 0;
  return (
    <div className="space-y-4" data-testid="onboarding-ai-apps">
      {hasReady && (
        <div className="space-y-1">
          <p className="text-sm">{connectedSentence(readyTypes, defaultRuntime.runtime)}</p>
          <DefaultRuntimePicker
            chosen={defaultRuntime.current}
            readyTypes={readyTypes}
            otherTypes={apps.filter((type) => !readyTypes.includes(type))}
            onChoose={defaultRuntime.choose}
          />
          {defaultRuntime.error && (
            <p className="text-destructive text-xs" data-testid="default-runtime-error">
              {defaultRuntime.error}
            </p>
          )}
        </div>
      )}
      <RuntimeSetupPanel
        types={apps}
        requirements={requirements}
        registeredTypes={registeredTypes}
        renderConnect={renderConnect}
        onRecheck={simulated ? undefined : () => void query.refetch()}
        isRechecking={query.isFetching}
      />
      {hasReady && (
        <Button className="w-full" onClick={onContinue} data-testid="onboarding-ai-app-continue">
          Continue
        </Button>
      )}
    </div>
  );
}

/**
 * Change which app new chats start with, without leaving the first run. Every
 * app is offered, not only the signed-in ones, and the others say so. A bottom
 * drawer on phones, a popover on desktop.
 */
function DefaultRuntimePicker({
  chosen,
  readyTypes,
  otherTypes,
  onChoose,
}: {
  chosen: string;
  readyTypes: string[];
  otherTypes: string[];
  onChoose: (type: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = [...readyTypes, ...otherTypes];
  if (!options.includes(chosen)) options.unshift(chosen);

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen}>
      <ResponsivePopoverTrigger
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 transition-colors hover:underline"
        data-testid="default-runtime-change"
      >
        Change
        <ChevronDown className="size-3" />
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent align="start" className="p-1">
        <ResponsivePopoverTitle>Start new chats with</ResponsivePopoverTitle>
        <div className="flex flex-col" role="listbox" aria-label="Start new chats with">
          {options.map((type) => {
            const isChosen = type === chosen;
            return (
              <button
                key={type}
                type="button"
                role="option"
                aria-selected={isChosen}
                onClick={() => {
                  onChoose(type);
                  setOpen(false);
                }}
                className="hover:bg-accent flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors"
                data-testid={`default-runtime-option-${type}`}
              >
                <span className="flex flex-col">
                  <span>{getRuntimeDescriptor(type).label}</span>
                  {!readyTypes.includes(type) && (
                    <span className="text-muted-foreground text-xs">Not signed in yet</span>
                  )}
                </span>
                {isChosen && <Check className="size-3.5 shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}

/**
 * What is signed in, and which app the next chat starts with, e.g. "Claude
 * Code is signed in. New chats start with it." The second half appears only
 * once the default is decided, so it never promises one that is not true.
 */
function connectedSentence(types: string[], defaultRuntime: string | null): string {
  const names = types.map((t) => getRuntimeDescriptor(t).label);
  const signedIn =
    names.length === 1
      ? `${names[0]} is signed in.`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are signed in.`
        : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]} are signed in.`;

  if (!defaultRuntime) return signedIn;
  if (types.length === 1 && types[0] === defaultRuntime) {
    return `${signedIn} New chats start with it.`;
  }
  const label = getRuntimeDescriptor(defaultRuntime).label;
  if (types.includes(defaultRuntime)) return `${signedIn} New chats start with ${label}.`;
  const meanwhile = chooseDefaultRuntime(types, defaultRuntime);
  const meanwhileLabel = meanwhile ? getRuntimeDescriptor(meanwhile).label : null;
  return meanwhileLabel
    ? `${signedIn} New chats use ${meanwhileLabel} until ${label} is signed in.`
    : `${signedIn} New chats start with ${label} once it’s signed in.`;
}
