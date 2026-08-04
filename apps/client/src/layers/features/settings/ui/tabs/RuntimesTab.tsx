import {
  RuntimeSetupPanel,
  useRuntimeCapabilities,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';
import { ClaudeAccountsCard } from '../ClaudeAccountsCard';
import { ExecutionDefaultsCard } from '../execution-defaults/ExecutionDefaultsCard';
import { ExecutionExceptionsStrip } from '../execution-defaults/ExecutionExceptionsStrip';

/**
 * Runtimes settings tab: live discovery + connect for the three agent
 * runtimes DorkOS speaks.
 *
 * COMPOSES, never duplicates: the sibling Ready/Connect cards and every
 * Connect action come straight from the entity's {@link RuntimeSetupPanel},
 * with connect flows rendered through {@link renderRuntimeConnect} (the same
 * terminal-free flow the status-bar picker, Run-with menu, and session-launch
 * popover open via `RuntimeSetupDialog`). This tab only adds the settings
 * framing (no page header), since the Settings dialog provides its own chrome.
 *
 * {@link ClaudeAccountsCard} is a SIBLING of that panel, never part of the
 * Claude Code card inside it: `RuntimeSection` is entities-layer and props-only,
 * and entities may not import the config hooks the accounts card needs (spec
 * `claude-code-accounts` D7).
 *
 * {@link ExecutionDefaultsCard} and its {@link ExecutionExceptionsStrip} are a
 * pair and stay adjacent: the card is what a new conversation starts with, and
 * the strip directly beneath it is every agent that ignores it (spec
 * `execution-defaults` §1). The strip draws nothing when the whole fleet
 * inherits, so on a fresh install the pair is just the card.
 */
export function RuntimesTab() {
  const requirementsQuery = useRuntimeRequirements();
  const { data: capabilityMap } = useRuntimeCapabilities();

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        DorkOS speaks three runtimes: connect any of them, each ready or one click away. Run
        frontier models in the cloud, or your own models locally, private and free.
      </p>

      <RuntimeSetupPanel
        requirements={requirementsQuery.data}
        registeredTypes={capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined}
        onRecheck={() => void requirementsQuery.refetch()}
        isRechecking={requirementsQuery.isFetching}
        renderConnect={renderRuntimeConnect}
      />

      <ExecutionDefaultsCard />
      <ExecutionExceptionsStrip />

      <ClaudeAccountsCard />
    </div>
  );
}
