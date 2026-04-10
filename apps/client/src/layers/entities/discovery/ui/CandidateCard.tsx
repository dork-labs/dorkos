import { Folder } from 'lucide-react';
import { motion } from 'motion/react';
import { Badge } from '@/layers/shared/ui/badge';
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';

// Human-readable descriptions for known detection strategies
const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  'claude-code': 'Detected a AGENTS.md file — this is a Claude Code project.',
  cursor: 'Detected a .cursor/ directory — this is a Cursor project.',
  codex: 'Detected a .codex/ directory — this is a Codex project.',
  'dork-manifest': 'Found an existing .dork/agent.json — already configured as a DorkOS agent.',
};

function strategyDescription(strategy: string): string {
  return STRATEGY_DESCRIPTIONS[strategy] ?? `Detected via "${strategy}" strategy.`;
}

// Human-readable descriptions for known agent capabilities
const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  'code-review': 'Reviews code for bugs, style issues, and correctness.',
  summarize: 'Summarizes documents, conversations, or code.',
  'file-ops': 'Reads and writes files on the filesystem.',
  test: 'Generates and runs tests for a codebase.',
  search: 'Searches code, files, or the web for relevant information.',
  refactor: 'Refactors code while preserving existing behavior.',
  analyze: 'Analyzes data, logs, or codebases for patterns and insights.',
  generate: 'Generates code, content, or structured output.',
  debug: 'Diagnoses and fixes bugs in code.',
  deploy: 'Manages deployment pipelines and infrastructure changes.',
};

function capabilityDescription(cap: string): string {
  return CAPABILITY_DESCRIPTIONS[cap] ?? 'Agent capability detected from project structure.';
}

interface CandidateCardProps {
  candidate: DiscoveryCandidate;
  onApprove: (candidate: DiscoveryCandidate) => void;
  onDeny?: (candidate: DiscoveryCandidate) => void;
  onSkip?: (candidate: DiscoveryCandidate) => void;
  className?: string;
}

/** Displays a discovered agent candidate with approve, deny, and optional skip actions. */
export function CandidateCard({
  candidate,
  onApprove,
  onDeny,
  onSkip,
  className,
}: CandidateCardProps) {
  const { path, strategy, hints } = candidate;

  return (
    <motion.div
      data-slot="candidate-card"
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={cn('flex items-start justify-between rounded-xl border p-4', className)}
    >
      <div className="min-w-0 flex-1 space-y-2">
        {/* Name */}
        <p className="text-sm leading-tight font-semibold">
          {hints.suggestedName || path.split('/').pop() || path}
        </p>

        {/* Path */}
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Folder className="size-3 shrink-0" />
          <span className="truncate font-mono">{path}</span>
        </div>

        {/* Runtime with HoverCard showing detection strategy */}
        <div className="flex flex-wrap items-center gap-1.5">
          <HoverCard openDelay={300}>
            <HoverCardTrigger asChild>
              <Badge variant="secondary" className="hover:bg-secondary/80 cursor-default text-xs">
                {hints.detectedRuntime}
              </Badge>
            </HoverCardTrigger>
            <HoverCardContent className="w-56 space-y-1.5 p-3" side="top" align="start">
              <p className="text-xs font-medium">Detected runtime</p>
              <p className="text-muted-foreground text-xs">{strategyDescription(strategy)}</p>
            </HoverCardContent>
          </HoverCard>

          {/* Inferred capabilities with per-badge tooltips */}
          {hints.inferredCapabilities &&
            hints.inferredCapabilities.length > 0 &&
            hints.inferredCapabilities.map((cap) => (
              <Tooltip key={cap}>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="cursor-default text-[10px]">
                    {cap}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-48 text-center">
                  {capabilityDescription(cap)}
                </TooltipContent>
              </Tooltip>
            ))}
        </div>
      </div>

      {/* Actions */}
      <div className="ml-4 flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onApprove(candidate)}
          className="focus-visible:ring-ring rounded-md bg-green-600/10 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-600/20 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none dark:text-green-400"
        >
          Add
        </button>
        {onSkip && (
          <button
            type="button"
            onClick={() => onSkip(candidate)}
            className="text-muted-foreground hover:bg-muted focus-visible:ring-ring rounded-md px-2.5 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Skip
          </button>
        )}
        {onDeny && (
          <button
            type="button"
            onClick={() => onDeny(candidate)}
            className="focus-visible:ring-ring rounded-md bg-red-600/10 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-600/20 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none dark:text-red-400"
          >
            Deny
          </button>
        )}
      </div>
    </motion.div>
  );
}
