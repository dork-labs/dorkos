import {
  RuntimeSetupPanel,
  useRuntimeCapabilities,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';

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
 */
export function RuntimesTab() {
  const requirementsQuery = useRuntimeRequirements();
  const { data: capabilityMap } = useRuntimeCapabilities();

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        DorkOS speaks three agent runtimes: connect any of them, each ready or one click away. Run
        frontier models in the cloud, or your own models locally, private and free.
      </p>

      <RuntimeSetupPanel
        requirements={requirementsQuery.data}
        registeredTypes={capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined}
        onRecheck={() => void requirementsQuery.refetch()}
        isRechecking={requirementsQuery.isFetching}
        renderConnect={renderRuntimeConnect}
      />
    </div>
  );
}
