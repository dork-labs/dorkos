export interface SystemModule {
  id: string
  name: string
  label: string
  description: string
  status: 'available' | 'coming-soon'
  group: 'platform' | 'engine-capability' | 'extension'
  /** External URL for modules with their own website (opens in new tab). */
  url?: string
}

export const systemModules: SystemModule[] = [
  {
    id: 'engine',
    name: 'Engine',
    label: 'Runtime',
    description:
      'The runtime that powers everything. Connects your AI agents, exposes a secure API, and runs Pulse, Relay, and Mesh as integrated capabilities.',
    status: 'available',
    group: 'platform',
  },
  {
    id: 'console',
    name: 'Console',
    label: 'Interface',
    description:
      'Your command center. Chat with agents, manage schedules, coordinate modules, and access your system from any browser.',
    status: 'available',
    group: 'platform',
  },
  {
    id: 'pulse',
    name: 'Pulse',
    label: 'Scheduler',
    description:
      'Autonomous execution loop that works while you sleep. Executes roadmaps, solicits feedback, self-improves.',
    status: 'coming-soon',
    group: 'engine-capability',
  },
  {
    id: 'relay',
    name: 'Relay',
    label: 'Message Bus',
    description:
      'The universal message bus. One format for agent-to-agent, human-to-agent, and external communication — with budget envelopes that prevent runaway loops.',
    status: 'coming-soon',
    group: 'engine-capability',
  },
  {
    id: 'mesh',
    name: 'Mesh',
    label: 'Agent Network',
    description:
      'Agent discovery and network topology. Every project is an agent — Mesh finds them, builds the registry, and writes the access control rules that Relay enforces.',
    status: 'coming-soon',
    group: 'engine-capability',
  },
  {
    id: 'wing',
    name: 'Wing',
    label: 'Life Layer',
    description:
      'Your always-on AI companion. Remembers what matters, helps you plan, keeps you accountable, and gives AI agents persistent context about your goals and life.',
    status: 'coming-soon',
    group: 'extension',
  },
  {
    id: 'loop',
    name: 'Loop',
    label: 'Improvement Engine',
    description:
      'Closes the feedback loop. Turns signals into hypotheses, hypotheses into tasks, and outcomes into the next iteration. Your system gets better while you sleep.',
    status: 'available',
    group: 'extension',
    url: 'https://www.looped.me/',
  },
]
