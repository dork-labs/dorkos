import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { DorkLogo } from '@dorkos/icons/logos';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import {
  useRuntimeRequirements,
  useRuntimeCapabilities,
  selectRuntimeReadiness,
  getRuntimeDescriptor,
  RuntimeSetupPanel,
  type RuntimeConnectSlot,
} from '@/layers/entities/runtime';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  HoverBorderGradient,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/layers/shared/ui';

/**
 * Two phases: `checking` keeps the original scan animation; `done` reveals the
 * outcome. There are no failure rows — a not-ready runtime is an opportunity to
 * connect, never an error. See ADR-0316/0318 (Ready/Connect model).
 */
type CheckPhase = 'checking' | 'done';

/** How long the scan animation holds before revealing the result, for pacing. */
const CHECKING_MIN_MS = 2200;

const HEADING_CHECKING = ['Checking', 'your', 'setup'];
const HEADING_READY = ["You're", 'ready'];
const HEADING_CONNECT = ['Connect', 'your', 'first', 'agent'];
const HEADING_ERROR = ['One', 'moment'];

interface SystemRequirementsStepProps {
  /** Advance out of the requirements step (at least one runtime is ready). */
  onContinue: () => void;
  /**
   * Feature-supplied connect-flow renderer, injected from the app shell (the
   * onboarding feature may not import the runtime-connect feature). Wires the
   * terminal-free flows — sign in with ChatGPT, paste key, provider picker —
   * into each connect card. Omit and cards fall back to their setup details.
   */
  renderConnect?: RuntimeConnectSlot;
  /**
   * Pre-baked requirements that bypass the live query — dev playground only, so
   * every state renders deterministically without a transport.
   */
  simulatedResult?: SystemRequirements;
}

/**
 * First-run setup check — shown after the welcome screen.
 *
 * Leads with readiness, not requirements: the moment one coding agent is ready,
 * the user can start. It runs the work for them (one-click installs, in-app
 * sign-in) instead of handing out terminal commands, and never blocks on
 * getting every runtime connected. Three outcomes after the scan:
 *
 * - **Ready** — at least one runtime is connected: a success moment with a
 *   single "Get started" CTA, and a quiet disclosure to add the others.
 * - **Connect** — nothing is ready yet: connect cards (Claude first) that do the
 *   setup, flipping to the Ready state the instant one succeeds.
 * - **Error** — the check could not reach the server: an honest, retryable note.
 */
export function SystemRequirementsStep({
  onContinue,
  renderConnect,
  simulatedResult,
}: SystemRequirementsStepProps) {
  const reducedMotion = useReducedMotion();
  const query = useRuntimeRequirements();
  const { data: capabilityMap } = useRuntimeCapabilities();

  const requirements = simulatedResult ?? query.data;
  const settled = simulatedResult !== undefined || query.isSuccess || query.isError;
  const errored = simulatedResult === undefined && query.isError;

  // Hold the scan animation for a beat even when the probe returns instantly.
  const [minElapsed, setMinElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMinElapsed(true), reducedMotion ? 0 : CHECKING_MIN_MS);
    return () => clearTimeout(timer);
  }, [reducedMotion]);

  const phase: CheckPhase = minElapsed && settled ? 'done' : 'checking';

  const registeredTypes = capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined;

  const { readyTypes, notReadyTypes } = useMemo(() => {
    if (!requirements) return { readyTypes: [] as string[], notReadyTypes: [] as string[] };
    const ready: string[] = [];
    const notReady: string[] = [];
    for (const type of Object.keys(requirements.runtimes)) {
      if (selectRuntimeReadiness(requirements, type, true).state === 'ready') ready.push(type);
      else notReady.push(type);
    }
    return { readyTypes: ready, notReadyTypes: notReady };
  }, [requirements]);

  const hasReady = readyTypes.length > 0;

  // Enter proceeds the moment the user is ready — the CTA is the obvious default.
  useEffect(() => {
    if (phase !== 'done' || errored || !hasReady) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      // Enter inside the disclosure's connect forms (e.g. pasting an API key)
      // must submit the form, not eject the user out of the step.
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable], form')) return;
      onContinue();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, errored, hasReady, onContinue]);

  const headingWords =
    phase === 'checking'
      ? HEADING_CHECKING
      : errored
        ? HEADING_ERROR
        : hasReady
          ? HEADING_READY
          : HEADING_CONNECT;

  const subtitle =
    phase === 'checking'
      ? 'Looking for coding agents on your machine.'
      : errored
        ? "We couldn't check your setup just now."
        : hasReady
          ? connectedSentence(readyTypes)
          : 'DorkOS drives coding agents. Set one up to get started. It takes about a minute.';

  const isActive = phase === 'checking';

  return (
    <motion.div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
      {/* Logo — pulses while scanning, settles when done. */}
      <motion.div
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
          <DorkLogo size={104} className="dark:hidden" />
          <DorkLogo variant="white" size={104} className="hidden dark:block" />
        </motion.div>
      </motion.div>

      <AnimatedHeading words={headingWords} reducedMotion={!!reducedMotion} />

      <AnimatePresence mode="wait">
        <motion.p
          key={subtitle}
          className="text-muted-foreground mt-3 text-sm text-balance"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
        >
          {subtitle}
        </motion.p>
      </AnimatePresence>

      {/* Scan animation */}
      <AnimatePresence>{isActive && <ScanningIndicator key="scanning" />}</AnimatePresence>

      {/* Outcome */}
      {phase === 'done' && (
        <div className="mt-8 w-full">
          {errored ? (
            <ErrorPanel onRetry={() => void query.refetch()} isRetrying={query.isFetching} />
          ) : hasReady ? (
            <ReadyView
              onContinue={onContinue}
              notReadyTypes={notReadyTypes}
              requirements={requirements}
              registeredTypes={registeredTypes}
              renderConnect={renderConnect}
              onRecheck={() => void query.refetch()}
              isRechecking={query.isFetching}
              reducedMotion={!!reducedMotion}
            />
          ) : (
            <motion.div
              initial={reducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="text-left"
            >
              <RuntimeSetupPanel
                requirements={requirements}
                registeredTypes={registeredTypes}
                renderConnect={renderConnect}
                onRecheck={() => void query.refetch()}
                isRechecking={query.isFetching}
              />
            </motion.div>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ── Ready state ──────────────────────────────────────────────

/**
 * The success moment: one primary CTA, plus a quiet disclosure to connect any
 * remaining runtimes without leaving onboarding.
 */
function ReadyView({
  onContinue,
  notReadyTypes,
  requirements,
  registeredTypes,
  renderConnect,
  onRecheck,
  isRechecking,
  reducedMotion,
}: {
  onContinue: () => void;
  notReadyTypes: string[];
  requirements?: SystemRequirements;
  registeredTypes?: string[];
  renderConnect?: RuntimeConnectSlot;
  onRecheck: () => void;
  isRechecking: boolean;
  reducedMotion: boolean;
}) {
  const [showMore, setShowMore] = useState(false);
  const moreCount = notReadyTypes.length;

  return (
    <motion.div
      className="flex flex-col items-center"
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <HoverBorderGradient
        className="px-6 py-2"
        duration={1.2}
        onClick={onContinue}
        autoFocus
        data-testid="onboarding-get-started"
      >
        Get started
      </HoverBorderGradient>

      {moreCount > 0 && (
        <Collapsible open={showMore} onOpenChange={setShowMore} className="mt-8 w-full">
          <CollapsibleTrigger className="text-muted-foreground hover:text-foreground mx-auto inline-flex items-center gap-1.5 text-xs transition-colors">
            <ChevronDown
              className={cn('size-3.5 transition-transform', showMore && 'rotate-180')}
            />
            {moreCount === 1 ? '1 more agent available' : `${moreCount} more agents available`}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4 space-y-3 text-left">
            <RuntimeSetupPanel
              types={notReadyTypes}
              requirements={requirements}
              registeredTypes={registeredTypes}
              renderConnect={renderConnect}
              onRecheck={onRecheck}
              isRechecking={isRechecking}
            />
            <p className="text-muted-foreground text-center text-xs">
              You can add these anytime from the status bar.
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
    </motion.div>
  );
}

// ── Error state ──────────────────────────────────────────────

/** Honest, retryable note when the requirements check cannot reach the server. */
function ErrorPanel({ onRetry, isRetrying }: { onRetry: () => void; isRetrying: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3" role="alert">
      <p className="text-muted-foreground text-sm text-balance">
        The check couldn't reach the server. Make sure DorkOS is running, then try again.
      </p>
      <Button variant="outline" className="gap-2" onClick={onRetry} disabled={isRetrying}>
        <RefreshCw className={cn('size-3.5', isRetrying && 'animate-spin')} />
        Try again
      </Button>
    </div>
  );
}

// ── Shared animation vocabulary ──────────────────────────────

/** Word-by-word blur reveal, keyed so a changed heading re-reveals in place. */
function AnimatedHeading({ words, reducedMotion }: { words: string[]; reducedMotion: boolean }) {
  return (
    <AnimatePresence mode="wait">
      <motion.h1
        key={words.join('-')}
        className="text-2xl font-semibold tracking-tight sm:text-3xl"
      >
        {reducedMotion ? (
          words.join(' ')
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
            {words.map((word, i) => (
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
                {i < words.length - 1 ? ' ' : ''}
              </motion.span>
            ))}
          </motion.span>
        )}
      </motion.h1>
    </AnimatePresence>
  );
}

/** Animated scanning indicator with sequentially pulsing dots. */
function ScanningIndicator() {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className="mt-8 flex flex-col items-center gap-4 py-2"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      data-testid="requirements-checking"
    >
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="bg-muted-foreground/40 size-2 rounded-full"
            animate={reducedMotion ? {} : { scale: [1, 1.5, 1], opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2, ease: 'easeInOut' }}
          />
        ))}
      </div>
      <span className="text-muted-foreground text-sm">Scanning…</span>
    </motion.div>
  );
}

/**
 * Human-readable sentence naming the connected runtime(s), e.g.
 * "Claude Code is connected." or "Claude Code and Codex are connected."
 */
function connectedSentence(types: string[]): string {
  const names = types.map((t) => getRuntimeDescriptor(t).label);
  if (names.length === 0) return 'An agent is connected.';
  if (names.length === 1) return `${names[0]} is connected.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are connected.`;
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')}, and ${last} are connected.`;
}
