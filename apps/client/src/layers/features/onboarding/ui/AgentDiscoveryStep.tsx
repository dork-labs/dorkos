import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search, ChevronDown, Sparkles } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useRegisterAgent, useMeshScanRoots } from '@/layers/entities/mesh';
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

interface AgentDiscoveryStepProps {
  onStepComplete: () => void;
}

/**
 * Step 1 of onboarding — discovers AI agent projects on the user's machine.
 *
 * Auto-starts scanning on mount. Shows progressive results as they arrive.
 * Existing agents (with `.dork/agent.json`) are shown as already registered.
 * New candidates require the user to approve or skip individually.
 *
 * @param onStepComplete - Called when the user advances past this step
 */
export function AgentDiscoveryStep({ onStepComplete }: AgentDiscoveryStepProps) {
  const { startScan } = useDiscoveryScan();
  const { candidates, existingAgents, isScanning, progress, error } = useDiscoveryStore();
  const registerAgent = useRegisterAgent();
  // Tracks paths the user has explicitly approved or skipped
  const { actedPaths, markActed, resetActed } = useActedPaths();
  const [hasStarted, setHasStarted] = useState(false);
  const [showScanOptions, setShowScanOptions] = useState(false);
  const [depth, setDepth] = useState(3);
  const { roots, setScanRoots } = useMeshScanRoots();
  const [localRoots, setLocalRoots] = useState<string[] | null>(null);
  const displayRoots = localRoots ?? roots;
  const reducedMotion = useReducedMotion();
  const autoStarted = useRef(false);

  // Auto-start scan on mount
  useEffect(() => {
    if (!autoStarted.current) {
      autoStarted.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializing scan state on first mount
      setHasStarted(true);
      startScan();
    }
  }, [startScan]);

  // Sort candidates after scan completes for stable display
  const displayCandidates = useMemo(
    () => (isScanning ? candidates : sortCandidates(candidates)),
    [candidates, isScanning]
  );

  const handleApprove = useCallback(
    (candidate: DiscoveryCandidate) => {
      // Mark acted immediately so the card exits; registration continues in background
      markActed(candidate.path);
      registerAgent.mutate({
        path: candidate.path,
        overrides: buildRegistrationOverrides(candidate),
      });
    },
    [registerAgent, markActed]
  );

  const handleSkip = useCallback(
    (candidate: DiscoveryCandidate) => {
      markActed(candidate.path);
    },
    [markActed]
  );

  const handleAddAll = useCallback(() => {
    for (const candidate of displayCandidates) {
      if (actedPaths.has(candidate.path)) continue;
      markActed(candidate.path);
      registerAgent.mutate({
        path: candidate.path,
        overrides: buildRegistrationOverrides(candidate),
      });
    }
  }, [displayCandidates, actedPaths, registerAgent, markActed]);

  const handleRootsChange = useCallback(
    (newRoots: string[]) => {
      setLocalRoots(newRoots);
      setScanRoots(newRoots);
    },
    [setScanRoots]
  );

  const handleRescan = useCallback(() => {
    resetActed();
    setHasStarted(true);
    startScan(displayRoots.length > 0 ? { roots: displayRoots, maxDepth: depth } : { roots: [] });
  }, [startScan, resetActed, displayRoots, depth]);

  // Zero candidates found: open the real creation dialog (the gallery, M2). A
  // successful create advances onboarding; closing it returns here cleanly (the
  // dialog is a modal over the onboarding overlay, which stays mounted).
  const handleCreateFirstAgent = useCallback(() => {
    useAgentCreationStore.getState().open('new', { onCreated: onStepComplete });
  }, [onStepComplete]);

  const hasExisting = existingAgents.length > 0;
  const hasCandidates = candidates.length > 0;
  const hasResults = hasExisting || hasCandidates;
  const scanComplete = hasStarted && !isScanning;
  const showNoResults = scanComplete && !hasResults;
  // "Continue" is primary when every visible candidate has been approved or skipped,
  // or when there are only existing agents (no candidates needing action)
  const allActed = !hasCandidates || candidates.every((c) => actedPaths.has(c.path));
  // Only show unacted candidates — acted ones animate out via AnimatePresence
  const pendingCandidates = displayCandidates.filter((c) => !actedPaths.has(c.path));

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center">
      {/* Header — adapts to scan state */}
      <div className="w-full shrink-0 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {isScanning && !hasResults
            ? 'Searching your machine...'
            : showNoResults
              ? 'Create Your First Agent'
              : 'Projects Found'}
        </h2>
        {isScanning && !hasResults && (
          <div className="mt-2 space-y-1">
            <p className="text-muted-foreground text-sm">
              Looking for existing projects on your machine.
            </p>
            <p className="text-muted-foreground text-sm">
              Once imported, your agents can work across them — and you can connect to Slack,
              Telegram, and more.
            </p>
          </div>
        )}
        {showNoResults && (
          <p className="text-muted-foreground mt-2 text-sm">
            No projects were found on your machine.
          </p>
        )}
      </div>

      {/* Scanning animation */}
      {isScanning && !hasResults && (
        <div className="mt-8 flex shrink-0 flex-col items-center gap-4">
          <motion.div
            animate={reducedMotion ? {} : { scale: [1, 1.15, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Search className="text-muted-foreground size-8" />
          </motion.div>
          {progress && (
            <p className="text-muted-foreground text-sm">
              Scanned {progress.scannedDirs} directories
            </p>
          )}
        </div>
      )}

      {/* Progress indicator during scan with results */}
      {isScanning && hasResults && progress && (
        <div className="text-muted-foreground mt-4 shrink-0 text-center text-sm">
          Scanning... {progress.scannedDirs} directories &middot; Found {progress.foundAgents}{' '}
          project{progress.foundAgents === 1 ? '' : 's'}
        </div>
      )}

      {/* Value prop after scan */}
      {scanComplete && hasResults && (
        <p className="text-muted-foreground mt-3 shrink-0 text-center text-sm">
          Add existing projects you want to manage in DorkOS. You can assign agents, schedule tasks,
          and connect to Slack, Telegram, and more.
        </p>
      )}

      {/* Error state */}
      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mt-6 shrink-0 rounded-lg border px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Scrollable results area — new projects first, imported collapsed at bottom */}
      {hasResults && (
        <div className="mt-4 min-h-0 w-full flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
            {/* Bulk add bar + new candidates first */}
            {pendingCandidates.length > 0 && (
              <BulkAddBar count={pendingCandidates.length} onAddAll={handleAddAll} />
            )}
            <AnimatePresence mode="popLayout">
              {pendingCandidates.map((candidate) => (
                <CandidateCard
                  key={candidate.path}
                  candidate={candidate}
                  onApprove={handleApprove}
                  onSkip={handleSkip}
                />
              ))}
            </AnimatePresence>

            {/* Already-imported — collapsed at bottom */}
            {hasExisting && <CollapsibleImportedSection agents={existingAgents} />}
          </div>
        </div>
      )}

      {/* No results — hand off to the real creation flow */}
      {showNoResults && (
        <div className="mt-6 w-full">
          <div className="flex flex-col items-center gap-2">
            <Button size="lg" onClick={handleCreateFirstAgent} data-testid="create-first-agent">
              <Sparkles className="size-4" />
              Create your first agent
            </Button>
            <p className="text-muted-foreground text-xs">
              Pick a ready-made agent or design your own.
            </p>
          </div>

          {/* Scan options — collapsible section for adjusting scan parameters */}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowScanOptions(!showScanOptions)}
              className="text-muted-foreground hover:text-foreground mx-auto flex items-center gap-1 text-xs"
            >
              <ChevronDown
                className={`size-3 transition-transform ${showScanOptions ? '' : '-rotate-90'}`}
              />
              Scan options
            </button>
            {showScanOptions && (
              <div className="bg-muted/30 mt-2 space-y-3 rounded-lg border p-3">
                <ScanRootInput roots={displayRoots} onChange={handleRootsChange} />
                <div className="flex items-center gap-3">
                  <label htmlFor="onboarding-scan-depth" className="text-muted-foreground text-xs">
                    Scan depth
                  </label>
                  <input
                    id="onboarding-scan-depth"
                    type="range"
                    min={1}
                    max={5}
                    value={depth}
                    onChange={(e) => setDepth(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="min-w-[1.5rem] text-center text-xs font-medium">{depth}</span>
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 flex flex-col items-center gap-3">
            <Button variant="outline" size="sm" onClick={handleRescan}>
              Scan Again
            </Button>
            <button
              onClick={onStepComplete}
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Continue without adding
            </button>
          </div>
        </div>
      )}

      {/* Continue button — always visible once scan completes with results */}
      {scanComplete && hasResults && (
        <div className="mt-4 flex shrink-0 flex-col items-center gap-2 border-t pt-4">
          <Button size="lg" onClick={onStepComplete} variant={allActed ? 'default' : 'outline'}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
