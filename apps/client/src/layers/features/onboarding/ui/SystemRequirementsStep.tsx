import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion, LayoutGroup } from 'motion/react';
import { Check, X, ExternalLink, Terminal, Copy, RefreshCw } from 'lucide-react';
import { DorkLogo } from '@dorkos/icons/logos';
import type { DependencyCheck, SystemRequirements } from '@dorkos/shared/agent-runtime';
import { useTransport } from '@/layers/shared/model';
import { cn, fireConfetti } from '@/layers/shared/lib';
import { Button, HoverBorderGradient } from '@/layers/shared/ui';

/**
 * Phase 1: "checking" — logo pulses, animated dots, heading says "Checking..."
 * Phase 2: "revealing" — rows appear one by one, each shimmer then resolve
 * Phase 3: "done" — heading transitions, CTA appears, confetti if all pass
 */
type CheckPhase = 'checking' | 'revealing' | 'done';

interface SystemRequirementsStepProps {
  /** Called when the user proceeds (all requirements satisfied). */
  onContinue: () => void;
  /** Pre-baked result to bypass the transport call — used by the dev playground. */
  simulatedResult?: SystemRequirements;
}

const HEADING_WORDS_CHECKING = ['Checking', 'system', 'requirements'];
const HEADING_WORDS_SUCCESS = ['Ready', 'to', 'go'];
const HEADING_WORDS_MISSING = ['Almost', 'there'];

/** Delay between each row reveal during the revealing phase. */
const REVEAL_INTERVAL_MS = 600;
/** How long each row "scans" before showing its result. */
const ROW_SCAN_DURATION_MS = 800;

/**
 * System requirements check — shown after the welcome screen.
 *
 * Creates a three-phase experience: scanning animation, progressive row-by-row
 * reveal with individual scan-to-result transitions, then a celebration or
 * install guidance depending on the results.
 */
export function SystemRequirementsStep({
  onContinue,
  simulatedResult,
}: SystemRequirementsStepProps) {
  const transport = useTransport();
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<CheckPhase>('checking');
  const [requirements, setRequirements] = useState<SystemRequirements | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const [runCount, setRunCount] = useState(0);

  // Progressive reveal: how many rows are visible, and which have resolved
  const [revealedCount, setRevealedCount] = useState(0);
  const [resolvedSet, setResolvedSet] = useState<Set<number>>(new Set());
  const confettiFired = useRef(false);

  const recheck = useCallback(() => {
    setPhase('checking');
    setRequirements(null);
    setError(null);
    setRevealedCount(0);
    setResolvedSet(new Set());
    confettiFired.current = false;
    setRunCount((n) => n + 1);
  }, []);

  // Phase 1: Fetch requirements (or use simulated result for playground)
  useEffect(() => {
    let cancelled = false;

    async function run() {
      const startedAt = Date.now();

      let result: SystemRequirements | null = null;
      let fetchError: string | null = null;

      if (simulatedResult) {
        result = simulatedResult;
      } else {
        try {
          result = await transport.checkRequirements();
        } catch (err) {
          fetchError = err instanceof Error ? err.message : 'Failed to check requirements';
        }
      }

      // Minimum 3s in checking phase
      const elapsed = Date.now() - startedAt;
      const MIN_DURATION_MS = 3000;
      if (elapsed < MIN_DURATION_MS) {
        await new Promise((r) => setTimeout(r, MIN_DURATION_MS - elapsed));
      }

      if (cancelled) return;
      if (fetchError) {
        setError(fetchError);
        setPhase('done');
      } else {
        setRequirements(result);
        setPhase('revealing');
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [transport, simulatedResult, runCount]);

  const allDeps = requirements
    ? Object.values(requirements.runtimes).flatMap((r) => r.dependencies)
    : [];
  const allSatisfied = requirements?.allSatisfied ?? false;
  const missingDeps = allDeps.filter((d) => d.status !== 'satisfied');

  // Phase 2: Progressive row reveal
  useEffect(() => {
    if (phase !== 'revealing' || allDeps.length === 0) return;

    if (revealedCount < allDeps.length) {
      const timer = setTimeout(
        () => setRevealedCount((n) => n + 1),
        revealedCount === 0 ? 200 : REVEAL_INTERVAL_MS
      );
      return () => clearTimeout(timer);
    }
  }, [phase, revealedCount, allDeps.length]);

  // Each row resolves from scanning → result after a delay
  useEffect(() => {
    if (phase !== 'revealing') return;

    for (let i = 0; i < revealedCount; i++) {
      if (resolvedSet.has(i)) continue;
      const timer = setTimeout(() => {
        setResolvedSet((prev) => new Set(prev).add(i));
      }, ROW_SCAN_DURATION_MS);
      return () => clearTimeout(timer);
    }
  }, [phase, revealedCount, resolvedSet]);

  // Phase 3: All rows resolved → transition to done
  useEffect(() => {
    if (phase !== 'revealing') return;
    if (allDeps.length === 0) return;
    if (resolvedSet.size < allDeps.length) return;

    const timer = setTimeout(() => {
      setPhase('done');
      if (allSatisfied && !confettiFired.current) {
        confettiFired.current = true;
        fireConfetti();
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [phase, resolvedSet.size, allDeps.length, allSatisfied]);

  const handleCopy = (depName: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedName(depName);
    setTimeout(() => setCopiedName(null), 2000);
  };

  const headingWords =
    phase === 'done'
      ? allSatisfied
        ? HEADING_WORDS_SUCCESS
        : HEADING_WORDS_MISSING
      : HEADING_WORDS_CHECKING;

  const isActive = phase === 'checking' || phase === 'revealing';

  return (
    <LayoutGroup>
      <motion.div
        layout={!reducedMotion}
        className="mx-auto flex w-full max-w-md flex-col items-center px-4 text-center"
        transition={{ layout: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] } }}
      >
        {/* Logo — pulses while active, settles when done */}
        <motion.div
          layout={!reducedMotion}
          className="mb-8"
          initial={reducedMotion ? false : { opacity: 0, scale: 0.8 }}
          animate={{ opacity: isActive ? 0.6 : 0.9, scale: 1 }}
          transition={{ duration: 0.5 }}
        >
          <motion.div
            animate={
              isActive && !reducedMotion
                ? { scale: [1, 1.04, 1], opacity: [0.6, 0.8, 0.6] }
                : { scale: 1, opacity: 1 }
            }
            transition={isActive ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : {}}
          >
            <DorkLogo size={120} className="dark:hidden" />
            <DorkLogo variant="white" size={120} className="hidden dark:block" />
          </motion.div>
        </motion.div>

        {/* Heading — opacity-only crossfade to avoid vertical shift */}
        <motion.div layout={!reducedMotion}>
          <AnimatePresence mode="wait">
            <motion.h1
              key={headingWords.join('-')}
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              {reducedMotion ? (
                headingWords.join(' ')
              ) : (
                <motion.span
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  variants={{
                    visible: { transition: { staggerChildren: 0.08 } },
                    exit: { transition: { staggerChildren: 0.02, staggerDirection: -1 } },
                  }}
                >
                  {headingWords.map((word, i) => (
                    <motion.span
                      key={i}
                      className="inline-block"
                      variants={{
                        hidden: { opacity: 0, filter: 'blur(4px)' },
                        visible: { opacity: 1, filter: 'blur(0px)' },
                        exit: { opacity: 0, filter: 'blur(4px)' },
                      }}
                      transition={{ duration: 0.3 }}
                    >
                      {word}
                      {i < headingWords.length - 1 ? '\u00A0' : ''}
                    </motion.span>
                  ))}
                </motion.span>
              )}
            </motion.h1>
          </AnimatePresence>
        </motion.div>

        {/* Subtitle — opacity crossfade, no movement */}
        <AnimatePresence mode="wait">
          <motion.p
            key={phase + String(allSatisfied)}
            className="text-muted-foreground mt-3 text-sm"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {phase === 'checking'
              ? 'Making sure everything is in place.'
              : phase === 'revealing'
                ? 'Verifying dependencies...'
                : allSatisfied
                  ? 'All dependencies are installed.'
                  : 'Some dependencies need to be installed.'}
          </motion.p>
        </AnimatePresence>

        {/* Results area — layout-animated so height changes are smooth */}
        <motion.div layout={!reducedMotion} className="mt-8 w-full">
          {/* Phase 1: Scanning dots */}
          <AnimatePresence>
            {phase === 'checking' && <ScanningIndicator key="scanning" />}
          </AnimatePresence>

          {/* Error state */}
          <AnimatePresence>
            {phase === 'done' && error && (
              <motion.div
                key="error"
                className="border-border bg-card rounded-xl border p-4 text-left"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="flex items-center gap-2">
                  <X className="text-destructive size-4 shrink-0" />
                  <span className="text-sm font-medium">Could not reach the server</span>
                </div>
                <p className="text-muted-foreground mt-1.5 text-xs">{error}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Phase 2+3: Progressive row reveal */}
          {(phase === 'revealing' || phase === 'done') && !error && (
            <div className="space-y-3">
              {allDeps.map((dep, i) => {
                if (i >= revealedCount) return null;
                const isResolved = resolvedSet.has(i);
                return <DependencyRow key={dep.name} dep={dep} isResolved={isResolved} index={i} />;
              })}
            </div>
          )}

          {/* Install guidance — appears after done */}
          <AnimatePresence>
            {phase === 'done' && missingDeps.length > 0 && (
              <motion.div
                className="border-border bg-card mt-3 space-y-3 rounded-xl border p-4 text-left"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ delay: 0.15, duration: 0.3 }}
              >
                <p className="text-sm font-medium">
                  {missingDeps.length === 1
                    ? 'One dependency is missing'
                    : `${missingDeps.length} dependencies are missing`}
                </p>
                {missingDeps.map((dep) => (
                  <div key={dep.name} className="space-y-2">
                    {dep.installHint && (
                      <div className="bg-muted flex items-center justify-between gap-2 rounded-lg px-3 py-2.5">
                        <div className="flex items-center gap-2 overflow-hidden">
                          <Terminal className="text-muted-foreground size-3.5 shrink-0" />
                          <code className="truncate text-xs">{dep.installHint}</code>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 px-1.5"
                          onClick={() => handleCopy(dep.name, dep.installHint!)}
                        >
                          {copiedName === dep.name ? (
                            <Check className="size-3" />
                          ) : (
                            <Copy className="size-3" />
                          )}
                        </Button>
                      </div>
                    )}
                    {dep.infoUrl && (
                      <a
                        href={dep.infoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
                      >
                        Learn more <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* CTA — layout-animated to smoothly enter the flow */}
        <AnimatePresence mode="wait">
          {phase === 'done' && !error && (
            <motion.div
              key={allSatisfied ? 'continue' : 'recheck'}
              layout={!reducedMotion}
              className="mt-10 flex flex-col items-center gap-3"
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ delay: 0.3, duration: 0.35 }}
            >
              {allSatisfied ? (
                <HoverBorderGradient className="px-6 py-2" duration={1.2} onClick={onContinue}>
                  Continue
                </HoverBorderGradient>
              ) : (
                <>
                  <Button onClick={recheck} variant="outline" className="gap-2">
                    <RefreshCw className="size-3.5" />
                    Check again
                  </Button>
                  <p className="text-muted-foreground text-xs">
                    Install the missing dependencies, then check again.
                  </p>
                </>
              )}
            </motion.div>
          )}

          {phase === 'done' && error && (
            <motion.div
              key="error-recheck"
              layout={!reducedMotion}
              className="mt-10 flex flex-col items-center gap-3"
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3, duration: 0.35 }}
            >
              <Button onClick={recheck} variant="outline" className="gap-2">
                <RefreshCw className="size-3.5" />
                Try again
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </LayoutGroup>
  );
}

// ── Internal components ──────────────────────────────────────

/** Animated scanning indicator with sequentially pulsing dots. */
function ScanningIndicator() {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className="flex flex-col items-center gap-4 py-6"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="bg-muted-foreground/40 size-2 rounded-full"
            animate={reducedMotion ? {} : { scale: [1, 1.5, 1], opacity: [0.3, 1, 0.3] }}
            transition={{
              duration: 1.2,
              repeat: Infinity,
              delay: i * 0.2,
              ease: 'easeInOut',
            }}
          />
        ))}
      </div>
      <span className="text-muted-foreground text-sm">Scanning...</span>
    </motion.div>
  );
}

/**
 * A single dependency row with a two-phase animation:
 * 1. Appears with a scanning shimmer placeholder
 * 2. Resolves to show the actual pass/fail result
 */
function DependencyRow({
  dep,
  isResolved,
  index,
}: {
  dep: DependencyCheck;
  isResolved: boolean;
  index: number;
}) {
  const isSatisfied = dep.status === 'satisfied';
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className={cn(
        'flex items-center gap-3 rounded-xl border px-4 py-3.5 transition-colors duration-500',
        isResolved && isSatisfied && 'border-emerald-500/20 bg-emerald-500/5',
        isResolved && !isSatisfied && 'border-destructive/20 bg-destructive/5',
        !isResolved && 'border-border bg-card'
      )}
      initial={reducedMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: 'spring',
        damping: 24,
        stiffness: 200,
        delay: index * 0.05,
      }}
    >
      {/* Icon: scanning dot → resolved icon */}
      <AnimatePresence mode="wait">
        {!isResolved ? (
          <motion.div
            key="scanning"
            className="bg-muted flex size-7 items-center justify-center rounded-full"
            exit={reducedMotion ? {} : { scale: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              className="bg-muted-foreground/30 size-3 rounded-full"
              animate={reducedMotion ? {} : { opacity: [0.3, 0.8, 0.3] }}
              transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
            />
          </motion.div>
        ) : isSatisfied ? (
          <motion.div
            key="pass"
            className="flex size-7 items-center justify-center rounded-full bg-emerald-500/15"
            initial={reducedMotion ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', damping: 10, stiffness: 400 }}
          >
            <Check className="size-4 text-emerald-500" />
          </motion.div>
        ) : (
          <motion.div
            key="fail"
            className="bg-destructive/10 flex size-7 items-center justify-center rounded-full"
            initial={reducedMotion ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', damping: 14, stiffness: 300 }}
          >
            <X className="text-destructive size-4" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Text: name always visible, subtitle crossfades */}
      <div className="min-w-0 flex-1 text-left">
        <p className="text-sm font-medium">{dep.name}</p>
        <AnimatePresence mode="wait">
          {isResolved ? (
            <motion.p
              key="resolved"
              className="text-muted-foreground truncate text-xs"
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              {isSatisfied && dep.version ? `v${dep.version}` : dep.description}
            </motion.p>
          ) : (
            <motion.p
              key="scanning"
              className="text-muted-foreground/50 text-xs"
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
            >
              Checking...
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
