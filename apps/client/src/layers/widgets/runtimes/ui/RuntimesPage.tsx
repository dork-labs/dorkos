/**
 * Runtimes surface (effortless-runtime-switching T2 task 3.4).
 *
 * The dedicated home for runtime discovery + connect. Three sibling cards —
 * Claude, Codex, OpenCode ({@link PRIMARY_RUNTIME_TYPES}) — each rendered as
 * Ready or a single Connect. This is where a Claude-only user learns DorkOS also
 * speaks Codex and OpenCode, and where the local-model superpower (OpenCode ·
 * Ollama, private + free) becomes discoverable.
 *
 * COMPOSES, never duplicates: the sibling cards and their Ready/Connect state
 * come from the entity's {@link RuntimeSetupPanel}, and every Connect action
 * opens the SAME terminal-free T1 flow via {@link renderRuntimeConnect} (the
 * OpenCode provider picker's Local path carries the guided Ollama pull, identity,
 * and per-model nature badges). This surface only adds the discovery framing.
 *
 * @module widgets/runtimes
 */
import {
  RuntimeSetupPanel,
  useRuntimeCapabilities,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';

/**
 * The `/runtimes` page — a calm, readable column of the three sibling runtimes,
 * each Ready or one Connect away. Responsive across mobile / tablet / desktop.
 */
export function RuntimesPage() {
  const requirementsQuery = useRuntimeRequirements();
  const { data: capabilityMap } = useRuntimeCapabilities();

  return (
    <div className="h-full overflow-y-auto" data-testid="runtimes-page">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
        <header className="mb-6 space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">Your runtimes</h1>
          <p className="text-muted-foreground text-sm">
            DorkOS speaks three agent runtimes. Connect any of them — each is ready or one click
            away. Run frontier models in the cloud, or your own models locally, private and free.
          </p>
        </header>

        <RuntimeSetupPanel
          requirements={requirementsQuery.data}
          registeredTypes={capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined}
          onRecheck={() => void requirementsQuery.refetch()}
          isRechecking={requirementsQuery.isFetching}
          renderConnect={renderRuntimeConnect}
        />
      </div>
    </div>
  );
}
