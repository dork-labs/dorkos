import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useRegisterAgent } from '@/layers/entities/mesh';
import { useDiscoveryScan, useDiscoveryStore, CandidateCard } from '@/layers/entities/discovery';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import { NoAgentsFound } from './NoAgentsFound';

interface AgentDiscoveryStepProps {
  onStepComplete: () => void;
}

/**
 * Sort candidates by relevance: dork-manifest first, then alphabetically by path.
 * Only applied after scan completes to avoid cards jumping during progressive results.
 */
function sortCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  return [...candidates].sort((a, b) => {
    // Dork-manifest agents first (already have a .dork/agent.json)
    const aIsDork = a.strategy === 'dork-manifest';
    const bIsDork = b.strategy === 'dork-manifest';
    if (aIsDork !== bIsDork) return aIsDork ? -1 : 1;
    // Then alphabetically by path for stable ordering
    return a.path.localeCompare(b.path);
  });
}

/**
 * Step 1 of onboarding — discovers AI agent projects on the user's machine.
 *
 * Auto-starts scanning on mount. Shows progressive results as they arrive.
 * Users approve or skip each candidate individually; "Continue" advances
 * once all visible candidates have been acted on.
 *
 * @param onStepComplete - Called when the user advances past this step
 */
export function AgentDiscoveryStep({ onStepComplete }: AgentDiscoveryStepProps) {
  const { startScan } = useDiscoveryScan();
  const { candidates, isScanning, progress, error } = useDiscoveryStore();
  const registerAgent = useRegisterAgent();
  // Tracks paths the user has explicitly approved or skipped
  const [actedPaths, setActedPaths] = useState<Set<string>>(new Set());
  const [hasStarted, setHasStarted] = useState(false);
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

  const markActed = useCallback((path: string) => {
    setActedPaths((prev) => new Set(prev).add(path));
  }, []);

  const handleApprove = useCallback(
    (candidate: DiscoveryCandidate) => {
      // Mark acted immediately so the card exits; registration continues in background
      markActed(candidate.path);
      registerAgent.mutate({
        path: candidate.path,
        overrides: {
          name: candidate.hints.suggestedName,
          runtime: candidate.hints.detectedRuntime,
          ...(candidate.hints.inferredCapabilities
            ? { capabilities: candidate.hints.inferredCapabilities }
            : {}),
          ...(candidate.hints.description ? { description: candidate.hints.description } : {}),
        },
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

  const handleRescan = useCallback(() => {
    setActedPaths(new Set());
    setHasStarted(true);
    startScan();
  }, [startScan]);

  const handleAgentCreated = useCallback(() => {
    // After creating an agent via the no-results form, re-scan
    handleRescan();
  }, [handleRescan]);

  const hasResults = candidates.length > 0;
  const scanComplete = hasStarted && !isScanning;
  const showNoResults = scanComplete && !hasResults;
  // "Continue" is primary when every visible candidate has been approved or skipped
  const allActed = hasResults && candidates.every((c) => actedPaths.has(c.path));
  // Only show unacted candidates — acted ones animate out via AnimatePresence
  const pendingCandidates = displayCandidates.filter((c) => !actedPaths.has(c.path));

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center">
      {/* Header — fixed at top */}
      <div className="w-full shrink-0 text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {isScanning && !hasResults ? 'Searching your projects...' : 'Discovered Agents'}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          We&rsquo;ll find AI-configured projects on your machine.
        </p>
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
          Found {candidates.length} project{candidates.length === 1 ? '' : 's'}. Approve or skip
          each one.
        </p>
      )}

      {/* Error state */}
      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mt-6 shrink-0 rounded-lg border px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Candidate cards — scrollable when list is long */}
      {hasResults && (
        <div className="mt-4 min-h-0 w-full flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
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
          </div>
        </div>
      )}

      {/* No results — guided agent creation */}
      {showNoResults && (
        <div className="mt-8 w-full">
          <NoAgentsFound onAgentCreated={handleAgentCreated} />
          <div className="mt-4 flex justify-center">
            <Button variant="outline" onClick={handleRescan}>
              Scan Again
            </Button>
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
