import { useQuery } from '@tanstack/react-query';
import type { CapabilityToolGroupKey } from '@dorkos/shared/mcp-tool-groups';
import { useTransport } from '@/layers/shared/model';

/**
 * Query key for one slice of the Capability Registry catalog.
 *
 * Keyed on the filter, because the transport asks the server for that slice
 * rather than the whole catalog: caching two different slices under one key
 * would serve the rooms grant's answer to whatever grant asked next.
 *
 * @param toolGroup - The grant the slice is about, or `undefined` for all of it.
 * @returns The query key.
 */
export const capabilityCatalogKey = (toolGroup?: string) =>
  ['capabilities', 'catalog', toolGroup ?? 'all'] as const;

/**
 * Read the Capability Registry's self-description catalog.
 *
 * The catalog is immutable for the life of a server process — its
 * `catalogVersion` is a content hash over declarations that are frozen at boot —
 * so this is cached hard rather than polled. A build that changes what a
 * capability declares also restarts the server.
 *
 * @param opts.toolGroup - Ask only for the capabilities behind this per-agent
 *   grant. Worth passing whenever you know it: the catalog is served paginated
 *   and compact, and only a narrowed request comes back in full.
 * @returns The TanStack Query result for that slice.
 */
export function useCapabilityCatalog(opts?: { toolGroup?: CapabilityToolGroupKey }) {
  const transport = useTransport();
  const toolGroup = opts?.toolGroup;
  return useQuery({
    queryKey: capabilityCatalogKey(toolGroup),
    queryFn: () => transport.getCapabilityCatalog(toolGroup ? { toolGroup } : undefined),
    staleTime: Infinity,
  });
}

/**
 * The MCP tool names behind one per-agent grant, read off the live catalog.
 *
 * **Derived, never listed.** Three hand-kept copies of "which tools are in this
 * group" drifted from the server and from each other (DOR-499), and the fix was
 * to keep the fact in one place and read it. A grant-bearing capability declares
 * its own `toolGroup`, so the catalog already knows the answer and this asks it.
 *
 * **Filtered on both sides, deliberately.** The server is asked for this group
 * and the result is filtered again here — not belt-and-braces for its own sake,
 * but because the two answers are about different things: the request keeps the
 * page small enough to arrive whole, and the check keeps this hook honest for a
 * transport that answers with more than it was asked for (the Obsidian embed
 * serves an empty catalog and a test may serve any catalog it likes).
 *
 * Sorted, so the order a person reads does not depend on the order domains
 * happened to compose in. Empty while the catalog loads, and empty on the
 * Obsidian embed, which runs no registry — a caller renders the switch either
 * way and simply names no tool.
 *
 * @param group - The grant to look up.
 * @returns The tool names, sorted; empty when the catalog is not (yet) readable.
 */
export function useToolNamesForGroup(group: CapabilityToolGroupKey): string[] {
  const { data } = useCapabilityCatalog({ toolGroup: group });
  return (
    (data?.capabilities ?? [])
      .filter((capability) => capability.toolGroup === group)
      // `surfaces?.` despite the type saying it is always there: this crossed a
      // wire and was typed by a cast rather than a parse, and the SAME route
      // serves a compact entry that carries no surfaces at all. The filter above
      // happens to exclude those today because compact drops `toolGroup` too —
      // one accident away from a crash rather than a missing badge.
      .map((capability) => capability.surfaces?.mcp?.toolName)
      .filter((name): name is string => Boolean(name))
      .sort()
  );
}
