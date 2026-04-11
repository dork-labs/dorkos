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
  BulkAddBar,
  CollapsibleImportedSection,
  ScanRootInput,
} from '@/layers/entities/discovery';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import { Button } from '@/layers/shared/ui';

/** Dark-mode-aware SVG illustration: magnifying glass scanning project folders. */
function ScanIllustration() {
  return (
    <svg viewBox="0 0 240 120" className="mx-auto h-24 w-48" aria-hidden="true">
      {/* Left folder */}
      <path
        d="M15 25 L33 25 L37 33 L60 33 L60 77 L15 77 Z"
        className="fill-none stroke-current"
        strokeWidth="1.5"
      />
      <rect x="23" y="44" width="16" height="2" rx="1" className="fill-current opacity-40" />
      <rect x="23" y="50" width="26" height="2" rx="1" className="fill-current opacity-20" />
      <rect x="23" y="56" width="20" height="2" rx="1" className="fill-current opacity-20" />

      {/* Right folder */}
      <path
        d="M180 25 L198 25 L202 33 L225 33 L225 77 L180 77 Z"
        className="fill-none stroke-current"
        strokeWidth="1.5"
      />
      <rect x="188" y="44" width="20" height="2" rx="1" className="fill-current opacity-40" />
      <rect x="188" y="50" width="14" height="2" rx="1" className="fill-current opacity-20" />
      <rect x="188" y="56" width="24" height="2" rx="1" className="fill-current opacity-20" />

      {/* Center magnifying glass */}
      <circle cx="120" cy="48" r="18" className="fill-none stroke-current" strokeWidth="2" />
      <line
        x1="133"
        y1="61"
        x2="148"
        y2="76"
        className="stroke-current"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* Lens highlight */}
      <path
        d="M110 38 Q114 33 120 32"
        className="fill-none stroke-current opacity-30"
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      {/* Dotted connection lines */}
      <line
        x1="63"
        y1="55"
        x2="102"
        y2="50"
        className="stroke-current opacity-40"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      <line
        x1="138"
        y1="50"
        x2="177"
        y2="55"
        className="stroke-current opacity-40"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
    </svg>
  );
}

const DETECTION_STRATEGIES = [
  { name: 'claude-code', signal: 'AGENTS.md', label: 'Claude Code project' },
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
  const preScan = !isPending && lastScanAt === null;

  function handleAddAll() {
    for (const c of visibleCandidates) {
      markActed(c.path);
      registerAgent(
        { path: c.path, overrides: buildRegistrationOverrides(c) },
        { onSuccess: () => markActed(c.path) }
      );
    }
  }

  // Shared Advanced disclosure — used in both pre-scan and post-scan states
  const advancedSection = (
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
  );

  return (
    <div className={fullBleed ? 'flex h-full flex-col p-6' : 'space-y-4 p-4'}>
      {preScan ? (
        <div className={fullBleed ? 'flex flex-1 items-center justify-center' : ''}>
          <div className={fullBleed ? 'w-full max-w-sm space-y-5' : 'space-y-5'}>
            <ScanIllustration />

            <div className="text-center">
              <p className="text-foreground text-sm font-medium">Find your existing projects</p>
              <p className="text-muted-foreground mx-auto mt-1 max-w-[300px] text-xs leading-relaxed">
                Scan your filesystem for Claude Code, Cursor, Codex, and other AI projects to manage
                in one place.
              </p>
            </div>

            {error && (
              <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-4 py-3 text-sm">
                {error}
              </div>
            )}

            <Button onClick={handleScan} disabled={displayRoots.length === 0} className="w-full">
              <Search className="size-4" />
              Search for Projects
            </Button>

            <p className="text-muted-foreground/60 text-center text-xs">
              Read-only scan — nothing changes until you approve
            </p>

            {advancedSection}
          </div>
        </div>
      ) : (
        <>
          {fullBleed && (
            <div className="mb-4 space-y-1">
              <h2 className="text-lg font-semibold">Import Projects</h2>
              <p className="text-muted-foreground text-sm">
                Search for existing projects to import into DorkOS.
              </p>
            </div>
          )}

          <div className="space-y-3">
            {advancedSection}

            <Button onClick={handleScan} disabled={isPending || displayRoots.length === 0}>
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Search for Projects
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
                      Found {progress.foundAgents} project
                      {progress.foundAgents === 1 ? '' : 's'}
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

            {/* No-results messaging — only after a scan has completed */}
            {scanComplete && !hasCandidates && hasExisting && (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <p className="text-sm font-medium">All projects already imported</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  All found projects are already imported. Check the Agents tab to see them.
                </p>
              </div>
            )}

            {scanComplete && !hasResults && (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <p className="text-sm font-medium">
                  {hasRegistered ? 'No new projects found' : 'No projects found'}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {hasRegistered
                    ? 'All found projects are already imported. Check the Agents tab to see them.'
                    : 'Try scanning deeper directories or adding different paths.'}
                </p>
              </div>
            )}

            {/* New candidates first — bulk add bar + individual cards */}
            {scanComplete && visibleCandidates.length > 0 && (
              <>
                <BulkAddBar count={visibleCandidates.length} onAddAll={handleAddAll} />
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
              </>
            )}

            {/* Already-imported — collapsed at bottom */}
            {scanComplete && hasExisting && (
              <div className="mt-3">
                <CollapsibleImportedSection agents={existingAgents} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
