import type { SystemModule } from '../lib/modules'

interface SystemArchitectureProps {
  modules: SystemModule[]
}

/** Interactive architecture diagram showing the 5 DorkOS modules as a connected system. */
export function SystemArchitecture({ modules }: SystemArchitectureProps) {
  return (
    <section id="system" className="py-32 px-8 bg-cream-tertiary">
      <div className="max-w-5xl mx-auto">
        <span className="font-mono text-2xs tracking-[0.15em] uppercase text-brand-orange text-center block mb-6">
          The System
        </span>

        <p className="text-charcoal text-[28px] md:text-[32px] font-medium tracking-[-0.02em] leading-[1.3] text-center max-w-2xl mx-auto mb-6">
          Five modules. One operating layer.
        </p>

        <p className="text-warm-gray text-base leading-[1.7] text-center max-w-xl mx-auto mb-16">
          DorkOS isn&apos;t a chat UI. It&apos;s an autonomous agent system with
          a heartbeat, a knowledge vault, and communication channels.
        </p>

        {/* Architecture diagram - SVG connections */}
        <div className="hidden md:block mb-16">
          <svg
            viewBox="0 0 600 200"
            className="w-full max-w-2xl mx-auto h-auto"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            {/* Top row connections: Console <-> Core <-> Vault */}
            <line
              x1="150"
              y1="50"
              x2="250"
              y2="50"
              stroke="var(--border-warm)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <line
              x1="350"
              y1="50"
              x2="450"
              y2="50"
              stroke="var(--border-warm)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            {/* Core to bottom row */}
            <line
              x1="300"
              y1="75"
              x2="200"
              y2="140"
              stroke="var(--border-warm)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
            <line
              x1="300"
              y1="75"
              x2="400"
              y2="140"
              stroke="var(--border-warm)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />

            {/* Node labels */}
            {[
              { x: 100, y: 50, label: 'Console' },
              { x: 300, y: 50, label: 'Core' },
              { x: 500, y: 50, label: 'Vault' },
              { x: 200, y: 160, label: 'Pulse' },
              { x: 400, y: 160, label: 'Channels' },
            ].map((node) => (
              <g key={node.label}>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="6"
                  fill="var(--color-brand-orange)"
                  opacity="0.8"
                />
                <text
                  x={node.x}
                  y={node.y + 22}
                  textAnchor="middle"
                  className="fill-charcoal text-[11px] font-mono"
                >
                  {node.label}
                </text>
              </g>
            ))}
          </svg>
        </div>

        {/* Module cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {modules.map((mod) => (
            <div
              key={mod.id}
              className="bg-cream-white rounded-lg p-6 border border-[var(--border-warm)]"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-charcoal text-lg">
                  {mod.name}
                </h3>
                <span
                  className={`font-mono text-3xs tracking-[0.1em] uppercase px-2 py-0.5 rounded ${
                    mod.status === 'available'
                      ? 'bg-brand-green/10 text-brand-green'
                      : 'bg-warm-gray-light/10 text-warm-gray-light'
                  }`}
                >
                  {mod.status === 'available' ? 'Available' : 'Coming Soon'}
                </span>
              </div>
              <p className="font-mono text-3xs text-warm-gray-light tracking-[0.05em] uppercase mb-2">
                {mod.label}
              </p>
              <p className="text-warm-gray text-sm leading-relaxed">
                {mod.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
