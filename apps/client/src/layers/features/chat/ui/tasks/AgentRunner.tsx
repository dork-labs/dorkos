import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/layers/shared/lib';
import { AgentRunnerBurst } from './AgentRunnerBurst';
import './agent-runner.css';

type RunnerPhase = 'running' | 'celebrating' | 'done';

/** How long the celebration burst plays before the runner settles into its mark. */
const SETTLE_DELAY_MS = 350;

/**
 * The states a runner figure can draw.
 *
 * `untracked` is an ending DorkOS did not witness — it lost sight of the task
 * (DOR-1108) — and gets the dash rather than the tick or the cross, both of
 * which would state an outcome nobody observed.
 */
export type AgentRunnerStatus = 'running' | 'complete' | 'error' | 'untracked';

/** Shape expected by AgentRunner for rendering an animated running figure. */
interface AgentRunnerAgent {
  taskId: string;
  description: string;
  status: AgentRunnerStatus;
  color: string;
  toolUses?: number;
  lastToolName?: string;
  durationMs?: number;
  summary?: string;
}

interface AgentRunnerProps {
  agent: AgentRunnerAgent;
  index: number;
}

/**
 * The mark a finished runner settles into: one shared ring, and one stroke
 * inside it saying how the run ended.
 *
 * Three marks, and the third is the point of the trio. A tick claims success and
 * a cross claims failure; `untracked` is the ending DorkOS did not witness
 * (DOR-1108), so it gets a dash — the same neutral the run-history panels
 * already use for a run nobody saw finish — drawn fainter than the other two
 * because it is the weakest claim of the three.
 *
 * @param props - The finished status and the runner's assigned colour.
 */
function DoneMark({ status, color }: { status: AgentRunnerAgent['status']; color: string }) {
  return (
    <svg className="check-appear h-6 w-[22px]" viewBox="0 0 22 24" data-status={status}>
      <circle cx="11" cy="12" r="7" fill="none" stroke={color} strokeWidth="1.5" opacity="0.3" />
      {status === 'error' && (
        <>
          <line
            x1="8"
            y1="9"
            x2="14"
            y2="15"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1="14"
            y1="9"
            x2="8"
            y2="15"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      )}
      {status === 'untracked' && (
        <line
          x1="8"
          y1="12"
          x2="14"
          y2="12"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.5"
        />
      )}
      {status !== 'error' && status !== 'untracked' && (
        <polyline
          points="7,12 10,15 15,9"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** Animated SVG running figure representing a single background agent. */
export function AgentRunner({ agent, index }: AgentRunnerProps) {
  const staggerStyle = useMemo(() => ({ animationDelay: `${index * 0.09}s` }), [index]);
  // A runner that first appears already finished never ran on screen, so it
  // opens on its mark instead of miming a run nobody is waiting for.
  const [phase, setPhase] = useState<RunnerPhase>(agent.status === 'running' ? 'running' : 'done');
  const prevStatusRef = useRef(agent.status);
  // The settle timer is held in a ref rather than returned as effect cleanup:
  // the effect's own setPhase used to re-run the effect and tear the timer down
  // before it fired, so the runner celebrated forever and no finished mark ever
  // appeared (DOR-1119).
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = agent.status;

    if (prevStatus === 'running' && agent.status !== 'running') {
      setPhase('celebrating');
      settleTimerRef.current = setTimeout(() => setPhase('done'), SETTLE_DELAY_MS);
      return;
    }

    // Running again before it settled: drop the pending mark and keep running.
    if (prevStatus !== 'running' && agent.status === 'running') {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
      setPhase('running');
    }
  }, [agent.status]);

  // Unmount is the only place the settle timer may be cancelled — see above.
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    []
  );

  if (phase === 'done') {
    return (
      <div className="relative inline-flex">
        <DoneMark status={agent.status} color={agent.color} />
      </div>
    );
  }

  return (
    <div className="group relative inline-flex">
      <svg
        className="h-6 w-[22px] shrink-0"
        style={{ '--c': agent.color } as React.CSSProperties}
        viewBox="0 0 22 24"
        aria-label={agent.description}
      >
        <g className="r-all" style={staggerStyle}>
          {/* Head */}
          <circle cx="11" cy="4.5" r="2.8" fill="var(--c)" />
          {/* Eye highlight */}
          <circle cx="12.3" cy="3.7" r="0.6" fill="hsl(0 0% 100% / 0.7)" />
          {/* Body */}
          <ellipse cx="11" cy="10.5" rx="2.5" ry="3.5" fill="var(--c)" />
          {/* Right arm */}
          <g className="r-rua" style={staggerStyle}>
            <line
              x1="12"
              y1="9"
              x2="14"
              y2="11"
              stroke="var(--c)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <g className="r-rfa" style={staggerStyle}>
              <line
                x1="14"
                y1="11"
                x2="14.5"
                y2="13"
                stroke="var(--c)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </g>
          </g>
          {/* Left arm */}
          <g className="r-lua" style={staggerStyle}>
            <line
              x1="10"
              y1="9"
              x2="8"
              y2="11"
              stroke="var(--c)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <g className="r-lfa" style={staggerStyle}>
              <line
                x1="8"
                y1="11"
                x2="7.5"
                y2="13"
                stroke="var(--c)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </g>
          </g>
          {/* Right leg */}
          <g className="r-rt" style={staggerStyle}>
            <line
              x1="11"
              y1="14"
              x2="13"
              y2="17"
              stroke="var(--c)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <g className="r-rs" style={staggerStyle}>
              <line
                x1="13"
                y1="17"
                x2="13.5"
                y2="21"
                stroke="var(--c)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </g>
          </g>
          {/* Left leg */}
          <g className="r-lt" style={staggerStyle}>
            <line
              x1="11"
              y1="14"
              x2="9"
              y2="17"
              stroke="var(--c)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <g className="r-ls" style={staggerStyle}>
              <line
                x1="9"
                y1="17"
                x2="8.5"
                y2="21"
                stroke="var(--c)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </g>
          </g>
        </g>
      </svg>

      {/* Particle burst overlay during celebration */}
      {phase === 'celebrating' && <AgentRunnerBurst color={agent.color} />}

      {/* Tooltip — CSS-only, shown on hover (running phase only).
          Desktop-only (`hidden md:block`): it needs a `:hover` no touch
          pointer has, and up to four of these can be on screen at once, so
          "always visible" here would stack four overlapping boxes rather
          than reveal one. The tap-to-expand task list (the chevron beside
          the bar, given real touch reach — see
          `EXPAND_TOGGLE_TOUCH_REACH` in `BackgroundTaskBar.tsx`) is the
          touch path to the same facts, `lastToolName` included — see
          `TaskDetailRow`. */}
      {phase === 'running' && (
        <div
          data-testid="agent-runner-tooltip"
          className={cn(
            'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 hidden',
            '-translate-x-1/2 translate-y-1 opacity-0 transition-[opacity,translate] duration-150',
            'group-hover:translate-y-0 group-hover:opacity-100',
            'border-border bg-popover z-10 rounded-lg border px-3 py-2 whitespace-nowrap',
            'text-foreground text-2xs shadow-lg md:block'
          )}
        >
          {/* Title with colored dot */}
          <div className="mb-0.5 flex items-center gap-1.5 font-semibold">
            <div
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: agent.color }}
            />
            {agent.description}
          </div>

          {/* Meta: tool count + duration */}
          <div className="text-muted-foreground text-3xs font-mono">
            {agent.toolUses ?? 0} tool calls · {Math.round((agent.durationMs ?? 0) / 1000)}s
          </div>

          {/* Last tool name */}
          {agent.lastToolName && (
            <div className="text-muted-foreground/60 text-3xs mt-0.5 font-mono">
              Last: {agent.lastToolName}
            </div>
          )}

          {/* Arrow pointing down */}
          <div className="border-t-border absolute top-full left-1/2 -translate-x-1/2 border-5 border-transparent" />
        </div>
      )}
    </div>
  );
}
