import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search, CheckCircle2 } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useRegisterAgent } from '@/layers/entities/mesh';
import {
  useDiscoveryScan,
  useDiscoveryStore,
  useActedPaths,
  buildRegistrationOverrides,
  CandidateCard,
} from '@/layers/entities/discovery';
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

  const handleRescan = useCallback(() => {
    resetActed();
    setHasStarted(true);
    startScan();
  }, [startScan]);

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
                  <div
                    key={agent.path}
                    className="bg-muted/50 flex items-center gap-3 rounded-lg border px-4 py-3"
                  >
                    <CheckCircle2 className="text-muted-foreground size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{agent.name}</p>
                      <p className="text-muted-foreground truncate text-xs">{agent.path}</p>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">Registered</span>
                  </div>
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
