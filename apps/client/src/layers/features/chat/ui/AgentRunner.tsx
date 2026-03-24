import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/layers/shared/lib';
import type { RunningAgent } from '../model/use-running-subagents';
import { AgentRunnerBurst } from './AgentRunnerBurst';
import './agent-runner.css';

type RunnerPhase = 'running' | 'celebrating' | 'done';

interface AgentRunnerProps {
  agent: RunningAgent;
  index: number;
}

/** Animated SVG running figure representing a single background agent. */
export function AgentRunner({ agent, index }: AgentRunnerProps) {
  const staggerStyle = useMemo(() => ({ animationDelay: `${index * 0.09}s` }), [index]);
  const [phase, setPhase] = useState<RunnerPhase>('running');
  const prevStatusRef = useRef(agent.status);

  useEffect(() => {
    if (
      prevStatusRef.current === 'running' &&
      (agent.status === 'complete' || agent.status === 'error') &&
      phase === 'running'
    ) {
      setPhase('celebrating');
      const checkTimer = setTimeout(() => setPhase('done'), 350);
      return () => clearTimeout(checkTimer);
    }
    prevStatusRef.current = agent.status;
  }, [agent.status, phase]);

  if (phase === 'done') {
    return (
      <div className="relative inline-flex">
        {agent.status === 'error' ? (
          <svg className="check-appear h-6 w-[22px]" viewBox="0 0 22 24">
            <circle
              cx="11"
              cy="12"
              r="7"
              fill="none"
              stroke={agent.color}
              strokeWidth="1.5"
              opacity="0.3"
            />
            <line
              x1="8"
              y1="9"
              x2="14"
              y2="15"
              stroke={agent.color}
              strokeWidth="2"
              strokeLinecap="round"
            />
            <line
              x1="14"
              y1="9"
              x2="8"
              y2="15"
              stroke={agent.color}
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg className="check-appear h-6 w-[22px]" viewBox="0 0 22 24">
            <circle
              cx="11"
              cy="12"
              r="7"
              fill="none"
              stroke={agent.color}
              strokeWidth="1.5"
              opacity="0.3"
            />
            <polyline
              points="7,12 10,15 15,9"
              fill="none"
              stroke={agent.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
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

      {/* Tooltip — CSS-only, shown on hover (running phase only) */}
      {phase === 'running' && (
        <div
          className={cn(
            'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2',
            '-translate-x-1/2 translate-y-1 opacity-0 transition-all duration-150',
            'group-hover:translate-y-0 group-hover:opacity-100',
            'z-10 rounded-lg border border-[hsl(0_0%_22%)] bg-[hsl(0_0%_12%)] px-3 py-2 whitespace-nowrap',
            'text-foreground text-[0.6875rem] shadow-[0_4px_12px_hsl(0_0%_0%/0.4)]'
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
          <div className="text-muted-foreground font-mono text-[0.625rem]">
            {agent.toolUses ?? 0} tool calls · {Math.round((agent.durationMs ?? 0) / 1000)}s
          </div>

          {/* Last tool name */}
          {agent.lastToolName && (
            <div className="text-muted-foreground/60 mt-0.5 font-mono text-[0.5625rem]">
              Last: {agent.lastToolName}
            </div>
          )}

          {/* Arrow pointing down */}
          <div
            className="absolute top-full left-1/2 -translate-x-1/2"
            style={{
              borderWidth: 5,
              borderStyle: 'solid',
              borderColor: 'hsl(0 0% 22%) transparent transparent transparent',
            }}
          />
        </div>
      )}
    </div>
  );
}
