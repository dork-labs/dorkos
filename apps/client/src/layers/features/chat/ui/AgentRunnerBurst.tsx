import './agent-runner.css';

interface AgentRunnerBurstProps {
  color: string;
}

/** Particle burst celebration — 8 colored particles explode outward from center. */
export function AgentRunnerBurst({ color }: AgentRunnerBurstProps) {
  const particles = [
    { bx: '-8px', by: '-10px', delay: '0s' },
    { bx: '8px', by: '-8px', delay: '0.03s' },
    { bx: '-6px', by: '6px', delay: '0.06s' },
    { bx: '10px', by: '4px', delay: '0.09s' },
    { bx: '0px', by: '-12px', delay: '0.04s' },
    { bx: '-10px', by: '0px', delay: '0.07s' },
    { bx: '6px', by: '10px', delay: '0.05s' },
    { bx: '-4px', by: '-6px', delay: '0.08s' },
  ] as const;

  return (
    <div className="pointer-events-none absolute inset-0">
      {particles.map((p, i) => (
        <span
          key={i}
          className="absolute top-1/2 left-1/2 size-[3px] rounded-full"
          style={
            {
              backgroundColor: color,
              '--bx': p.bx,
              '--by': p.by,
              animation: `burst-particle 0.5s ease-out ${p.delay} forwards`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
