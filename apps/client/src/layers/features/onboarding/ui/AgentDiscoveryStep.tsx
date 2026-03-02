import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search, CheckSquare, Square } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useRegisterAgent } from '@/layers/entities/mesh';
import { useDiscoveryScan, type ScanCandidate } from '../model/use-discovery-scan';
import { AgentCard } from './AgentCard';
import { NoAgentsFound } from './NoAgentsFound';

/** Threshold for showing bulk selection controls. */
const SELECT_ALL_THRESHOLD = 6;

interface AgentDiscoveryStepProps {
  onStepComplete: () => void;
}

/**
 * Sort candidates by relevance: manifest-registered first, then by marker count descending.
 * Only applied after scan completes to avoid cards jumping during progressive results.
 */
function sortCandidates(candidates: ScanCandidate[]): ScanCandidate[] {
  return [...candidates].sort((a, b) => {
    // Manifest-registered agents first
    if (a.hasDorkManifest !== b.hasDorkManifest) return a.hasDorkManifest ? -1 : 1;
    // Then by marker count (more markers = more relevant)
    return b.markers.length - a.markers.length;
  });
}

/**
 * Step 1 of onboarding — discovers AI agent projects on the user's machine.
 *
 * Auto-starts scanning on mount. Shows progressive results as they arrive
 * with staggered entrance animations. No agents are selected by default —
 * users opt in to registration.
 *
 * @param onStepComplete - Called when the user confirms or skips
 */
export function AgentDiscoveryStep({ onStepComplete }: AgentDiscoveryStepProps) {
  const { candidates, isScanning, progress, error, startScan } = useDiscoveryScan();
  const registerAgent = useRegisterAgent();
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [hasStarted, setHasStarted] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const reducedMotion = useReducedMotion();
  const autoStarted = useRef(false);

  // Auto-start scan on mount
  useEffect(() => {
    if (!autoStarted.current) {
      autoStarted.current = true;
      setHasStarted(true);
      startScan();
    }
  }, [startScan]);

  // Sort candidates after scan completes for stable display
  const displayCandidates = useMemo(
    () => (isScanning ? candidates : sortCandidates(candidates)),
    [candidates, isScanning],
  );

  const handleToggle = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedPaths(new Set(candidates.map((c) => c.path)));
  }, [candidates]);

  const handleDeselectAll = useCallback(() => {
    setSelectedPaths(new Set());
  }, []);

  const handleRescan = useCallback(() => {
    setSelectedPaths(new Set());
    setHasStarted(true);
    startScan();
  }, [startScan]);

  const handleConfirm = useCallback(async () => {
    if (selectedPaths.size === 0) {
      // Skip without registering
      onStepComplete();
      return;
    }
    setIsRegistering(true);
    const paths = Array.from(selectedPaths);
    try {
      await Promise.all(paths.map((p) => registerAgent.mutateAsync({ path: p })));
    } catch {
      // Continue even if some registrations fail — agents can be registered later
    } finally {
      setIsRegistering(false);
      onStepComplete();
    }
  }, [selectedPaths, registerAgent, onStepComplete]);

  const handleAgentCreated = useCallback(() => {
    // After creating an agent via the no-results form, re-scan
    handleRescan();
  }, [handleRescan]);

  const hasResults = candidates.length > 0;
  const scanComplete = hasStarted && !isScanning;
  const showNoResults = scanComplete && !hasResults;
  const showBulkControls = !isScanning && candidates.length >= SELECT_ALL_THRESHOLD;
  const allSelected = hasResults && selectedPaths.size === candidates.length;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center">
      {/* Header — fixed at top */}
      <div className="w-full shrink-0 text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {isScanning && !hasResults ? 'Searching your projects...' : 'Discovered Agents'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
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
            <Search className="size-8 text-muted-foreground" />
          </motion.div>
          {progress && (
            <p className="text-sm text-muted-foreground">
              Scanned {progress.scannedDirs} directories
            </p>
          )}
        </div>
      )}

      {/* Progress indicator during scan with results */}
      {isScanning && hasResults && progress && (
        <div className="mt-4 shrink-0 text-center text-sm text-muted-foreground">
          Scanning... {progress.scannedDirs} directories &middot; Found {progress.foundAgents} agent
          {progress.foundAgents === 1 ? '' : 's'}
        </div>
      )}

      {/* Summary after scan */}
      {scanComplete && hasResults && (
        <p className="mt-4 shrink-0 text-center text-sm text-muted-foreground">
          Found {candidates.length} project{candidates.length === 1 ? '' : 's'}. Select the ones
          you want to register.
        </p>
      )}

      {/* Error state */}
      {error && (
        <div className="mt-6 shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Bulk selection controls */}
      <AnimatePresence>
        {showBulkControls && (
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="mt-4 w-full shrink-0 overflow-hidden"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {selectedPaths.size} of {candidates.length} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={allSelected ? handleDeselectAll : handleSelectAll}
                className="gap-1.5 text-sm"
              >
                {allSelected ? (
                  <>
                    <Square className="size-3.5" />
                    Deselect all
                  </>
                ) : (
                  <>
                    <CheckSquare className="size-3.5" />
                    Select all
                  </>
                )}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Agent cards list — scrollable when list is long */}
      {hasResults && (
        <div className="mt-4 min-h-0 w-full flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {displayCandidates.map((candidate) => (
                <motion.div
                  key={candidate.path}
                  layout={!reducedMotion}
                  initial={reducedMotion ? false : { opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                >
                  <AgentCard
                    candidate={candidate}
                    selected={selectedPaths.has(candidate.path)}
                    onToggle={() => handleToggle(candidate.path)}
                  />
                </motion.div>
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

      {/* Action buttons — fixed at bottom */}
      {scanComplete && hasResults && (
        <div className="mt-6 flex shrink-0 flex-col items-center gap-3 border-t pt-6">
          <Button
            size="lg"
            onClick={handleConfirm}
            disabled={isRegistering}
            variant={selectedPaths.size === 0 ? 'outline' : 'default'}
          >
            {isRegistering
              ? 'Registering...'
              : selectedPaths.size > 0
                ? `Register ${selectedPaths.size} agent${selectedPaths.size === 1 ? '' : 's'}`
                : 'Continue without registering'}
          </Button>
          <p className="text-xs text-muted-foreground">
            You can discover more agents anytime from the Mesh panel.
          </p>
        </div>
      )}
    </div>
  );
}
