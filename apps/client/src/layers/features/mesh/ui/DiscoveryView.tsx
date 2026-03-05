import { useState } from 'react';
import { ChevronDown, Loader2, Search, FolderSearch } from 'lucide-react';
import { useDiscoverAgents, useMeshScanRoots, useRegisteredAgents, useRegisterAgent, useDenyAgent } from '@/layers/entities/mesh';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import { ScanRootInput } from './ScanRootInput';
import { CandidateCard } from './CandidateCard';

const DETECTION_STRATEGIES = [
  { name: 'claude-code', signal: 'CLAUDE.md', label: 'Claude Code project' },
  { name: 'cursor', signal: '.cursor/', label: 'Cursor project' },
  { name: 'codex', signal: '.codex/', label: 'Codex project' },
  { name: 'dork', signal: '.dork/agent.json', label: 'DorkOS agent (auto-imported)' },
] as const;

interface DiscoveryViewProps {
  /** When true, renders as full-bleed Mode A with contextual headline. */
  fullBleed?: boolean;
}

/** Discovery view — used as full-bleed Mode A or as a tab in Mode B. */
export function DiscoveryView({ fullBleed = false }: DiscoveryViewProps) {
  const { roots, setScanRoots } = useMeshScanRoots();
  const [localRoots, setLocalRoots] = useState<string[] | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [depth, setDepth] = useState(3);
  const { mutate: discover, data: result, isPending } = useDiscoverAgents();
  const { mutate: registerAgent } = useRegisterAgent();
  const { mutate: denyAgent } = useDenyAgent();
  const { data: agentsResult } = useRegisteredAgents();

  // Use local edits if user has modified, otherwise use persisted roots
  const displayRoots = localRoots ?? roots;

  function handleRootsChange(newRoots: string[]) {
    setLocalRoots(newRoots);
    setScanRoots(newRoots);
  }

  function handleScan() {
    if (displayRoots.length > 0) {
      discover({ roots: displayRoots, maxDepth: depth });
    }
  }

  const [actedPaths, setActedPaths] = useState<Set<string>>(new Set());
  const visibleCandidates = result?.candidates?.filter((c) => !actedPaths.has(c.path));

  function markActed(path: string) {
    setActedPaths((prev) => new Set([...prev, path]));
  }

  return (
    <div className={fullBleed ? 'flex h-full flex-col p-6' : 'space-y-4 p-4'}>
      {fullBleed && (
        <div className="mb-4 space-y-1">
          <h2 className="text-lg font-semibold">Discover Agents</h2>
          <p className="text-sm text-muted-foreground">
            Scan directories to find agents on your computer.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {/* Advanced section — scan paths + depth */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={`size-3 transition-transform ${showAdvanced ? '' : '-rotate-90'}`}
            />
            Advanced
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-3 rounded-lg border bg-muted/30 p-3">
              <ScanRootInput roots={displayRoots} onChange={handleRootsChange} />
              <div className="flex items-center gap-3">
                <label htmlFor="scan-depth" className="text-xs text-muted-foreground">
                  Scan depth
                </label>
                <input
                  id="scan-depth"
                  type="range"
                  min={1}
                  max={5}
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="min-w-[1.5rem] text-center text-xs font-medium">{depth}</span>
              </div>
              <div className="space-y-1.5">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <FolderSearch className="size-3" />
                  Detection strategies
                </p>
                <ul className="space-y-1 pl-4">
                  {DETECTION_STRATEGIES.map((s) => (
                    <li key={s.name} className="flex items-baseline gap-1.5">
                      <code className="text-[10px] text-foreground/70">{s.signal}</code>
                      <span className="text-[10px] text-muted-foreground">→ {s.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleScan}
          disabled={isPending || displayRoots.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          Scan for Agents
        </button>
      </div>

      {/* Results */}
      <div className={fullBleed ? 'mt-4 flex-1 overflow-y-auto' : ''}>
        {isPending && (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isPending && visibleCandidates && visibleCandidates.length === 0 && (() => {
          const hasRegistered = (agentsResult?.agents?.length ?? 0) > 0;
          return (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <p className="text-sm font-medium">
                {hasRegistered ? 'No new agents found' : 'No agents found'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {hasRegistered
                  ? 'All discovered agents are already registered. Check the Agents tab to see them.'
                  : 'Try scanning deeper directories or adding different paths.'}
              </p>
            </div>
          );
        })()}

        {!isPending && visibleCandidates && visibleCandidates.length > 0 && (
          <div className="space-y-2">
            {visibleCandidates.map((c: DiscoveryCandidate) => (
              <CandidateCard
                key={c.path}
                candidate={c}
                onApprove={(cand) =>
                  registerAgent(
                    {
                      path: cand.path,
                      overrides: {
                        name: cand.hints.suggestedName,
                        runtime: cand.hints.detectedRuntime,
                        ...(cand.hints.inferredCapabilities ? { capabilities: cand.hints.inferredCapabilities } : {}),
                        ...(cand.hints.description ? { description: cand.hints.description } : {}),
                      },
                    },
                    { onSuccess: () => markActed(cand.path) },
                  )
                }
                onDeny={(cand) =>
                  denyAgent({ path: cand.path }, { onSuccess: () => markActed(cand.path) })
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
