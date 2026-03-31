import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search, ChevronDown } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useRegisterAgent, useDenyAgent, useMeshScanRoots } from '@/layers/entities/mesh';
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
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import { NoAgentsFound } from './NoAgentsFound';

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
  const { mutate: denyAgent } = useDenyAgent();
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

  const handleDeny = useCallback(
    (candidate: DiscoveryCandidate) => {
      markActed(candidate.path);
      denyAgent({ path: candidate.path });
    },
    [denyAgent, markActed]
  );

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

  const handleAgentCreated = useCallback(() => {
    // After creating an agent via the no-results form, re-scan
    handleRescan();
  }, [handleRescan]);

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
            ? 'Searching your projects...'
            : showNoResults
              ? 'Create Your First Agent'
              : 'Discovered Agents'}
        </h2>
        {isScanning && !hasResults && (
          <p className="text-muted-foreground mt-2 text-sm">
            Looking for AI-configured projects on your machine.
          </p>
        )}
        {showNoResults && (
          <p className="text-muted-foreground mt-2 text-sm">
            No AI-configured projects were found on your machine.
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
          Scanning... {progress.scannedDirs} directories &middot; Found {progress.foundAgents} agent
          {progress.foundAgents === 1 ? '' : 's'}
        </div>
      )}

      {/* Summary after scan */}
      {scanComplete && hasResults && (
        <p className="text-muted-foreground mt-4 shrink-0 text-center text-sm">
          {hasExisting && !hasCandidates
            ? `Found ${existingAgents.length} existing agent${existingAgents.length === 1 ? '' : 's'} — already configured.`
            : hasExisting && hasCandidates
              ? `Found ${existingAgents.length} existing and ${candidates.length} new project${candidates.length === 1 ? '' : 's'}. Approve or skip the new ones.`
              : `Found ${candidates.length} project${candidates.length === 1 ? '' : 's'}. Approve or skip each one.`}
        </p>
      )}

      {/* Error state */}
      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mt-6 shrink-0 rounded-lg border px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Scrollable results area */}
      {hasResults && (
        <div className="mt-4 min-h-0 w-full flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
            {/* Existing agents — already registered, display-only */}
            {hasExisting && (
              <div className="space-y-2">
                {existingAgents.map((agent) => (
                  <ExistingAgentCard key={agent.path} agent={agent} />
                ))}
              </div>
            )}

            {/* New candidates — require user action */}
            <AnimatePresence mode="popLayout">
              {pendingCandidates.map((candidate) => (
                <CandidateCard
                  key={candidate.path}
                  candidate={candidate}
                  onApprove={handleApprove}
                  onSkip={handleSkip}
                  onDeny={handleDeny}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* No results — guided agent creation */}
      {showNoResults && (
        <div className="mt-6 w-full">
          <NoAgentsFound onAgentCreated={handleAgentCreated} />

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
              Continue without agents
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
