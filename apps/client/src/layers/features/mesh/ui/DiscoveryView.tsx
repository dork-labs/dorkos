import { useMemo, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ChevronDown, Loader2, Search, FolderSearch } from 'lucide-react';
import {
  useMeshScanRoots,
  useRegisteredAgents,
  useRegisterAgent,
  useDenyAgent,
} from '@/layers/entities/mesh';
import {
  useDiscoveryScan,
  useDiscoveryStore,
  useActedPaths,
  buildRegistrationOverrides,
  sortCandidates,
  CandidateCard,
  ExistingAgentCard,
  ScanRootInput,
} from '@/layers/entities/discovery';
import type { DiscoveryCandidate, ExistingAgent } from '@dorkos/shared/mesh-schemas';
import { Button } from '@/layers/shared/ui';

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
  const { startScan } = useDiscoveryScan();
  const {
    candidates,
    existingAgents,
    isScanning: isPending,
    progress,
    error,
    lastScanAt,
  } = useDiscoveryStore();
  const { mutate: registerAgent } = useRegisterAgent();
  const { mutate: denyAgent } = useDenyAgent();
  const { data: agentsResult } = useRegisteredAgents();
  const { actedPaths, markActed, resetActed } = useActedPaths();

  // Use local edits if user has modified, otherwise use persisted roots
  const displayRoots = localRoots ?? roots;

  function handleRootsChange(newRoots: string[]) {
    setLocalRoots(newRoots);
    setScanRoots(newRoots);
  }

  function handleScan() {
    if (displayRoots.length > 0) {
      resetActed();
      startScan({ roots: displayRoots, maxDepth: depth });
    }
  }

  // Sort candidates after scan completes for stable display
  const displayCandidates = useMemo(
    () => (isPending ? candidates : sortCandidates(candidates)),
    [candidates, isPending]
  );

  const visibleCandidates = displayCandidates.filter((c) => !actedPaths.has(c.path));
  const hasRegistered = (agentsResult?.agents?.length ?? 0) > 0;
  const hasExisting = existingAgents.length > 0;
  const hasCandidates = candidates.length > 0;
  const hasResults = hasExisting || hasCandidates;
  const scanComplete = !isPending && lastScanAt !== null;

  return (
    <div className={fullBleed ? 'flex h-full flex-col p-6' : 'space-y-4 p-4'}>
      {fullBleed && (
        <div className="mb-4 space-y-1">
          <h2 className="text-lg font-semibold">Discover Agents</h2>
          <p className="text-muted-foreground text-sm">
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
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
          >
            <ChevronDown
              className={`size-3 transition-transform ${showAdvanced ? '' : '-rotate-90'}`}
            />
            Advanced
          </button>
          {showAdvanced && (
            <div className="bg-muted/30 mt-2 space-y-3 rounded-lg border p-3">
              <ScanRootInput roots={displayRoots} onChange={handleRootsChange} />
              <div className="flex items-center gap-3">
                <label htmlFor="scan-depth" className="text-muted-foreground text-xs">
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
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <FolderSearch className="size-3" />
                  Detection strategies
                </p>
                <ul className="space-y-1 pl-4">
                  {DETECTION_STRATEGIES.map((s) => (
                    <li key={s.name} className="flex items-baseline gap-1.5">
                      <code className="text-foreground/70 text-[10px]">{s.signal}</code>
                      <span className="text-muted-foreground text-[10px]">→ {s.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        <Button onClick={handleScan} disabled={isPending || displayRoots.length === 0}>
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          Scan for Agents
        </Button>
      </div>

      {/* Results */}
      <div className={fullBleed ? 'mt-4 flex-1 overflow-y-auto' : ''}>
        {isPending && (
          <div className="flex flex-col items-center justify-center gap-2 p-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
            {progress && (
              <div className="text-muted-foreground space-y-0.5 text-center text-xs">
                <p>Scanned {progress.scannedDirs} directories</p>
                <p>
                  Found {progress.foundAgents} agent{progress.foundAgents === 1 ? '' : 's'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="border-destructive/30 bg-destructive/5 text-destructive mb-3 rounded-lg border px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Existing agents — already registered, display-only */}
        {scanComplete && hasExisting && (
          <div className="mb-3 space-y-2">
            {existingAgents.map((agent: ExistingAgent) => (
              <ExistingAgentCard key={agent.path} agent={agent} />
            ))}
          </div>
        )}

        {/* No-results messaging — only after a scan has completed */}
        {scanComplete && !hasCandidates && hasExisting && (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <p className="text-sm font-medium">All agents already registered</p>
            <p className="text-muted-foreground mt-1 text-xs">
              All discovered agents are already configured. Check the Agents tab to see them.
            </p>
          </div>
        )}

        {scanComplete && !hasResults && (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <p className="text-sm font-medium">
              {hasRegistered ? 'No new agents found' : 'No agents found'}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {hasRegistered
                ? 'All discovered agents are already registered. Check the Agents tab to see them.'
                : 'Try scanning deeper directories or adding different paths.'}
            </p>
          </div>
        )}

        {/* New candidates — require user action */}
        {scanComplete && visibleCandidates.length > 0 && (
          <AnimatePresence mode="popLayout">
            {visibleCandidates.map((c: DiscoveryCandidate) => (
              <CandidateCard
                key={c.path}
                candidate={c}
                className="mb-2"
                onApprove={(cand) =>
                  registerAgent(
                    {
                      path: cand.path,
                      overrides: buildRegistrationOverrides(cand),
                    },
                    { onSuccess: () => markActed(cand.path) }
                  )
                }
                onSkip={(cand) => markActed(cand.path)}
                onDeny={(cand) =>
                  denyAgent({ path: cand.path }, { onSuccess: () => markActed(cand.path) })
                }
              />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
