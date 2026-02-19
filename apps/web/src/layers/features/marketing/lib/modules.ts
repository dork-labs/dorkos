export interface SystemModule {
  id: string
  name: string
  label: string
  description: string
  status: 'available' | 'coming-soon'
}

export const systemModules: SystemModule[] = [
  {
    id: 'core',
    name: 'Core',
    label: 'AI Server',
    description:
      'The engine. Wraps Claude Code CLI, exposes a secure API, enables remote access.',
    status: 'available',
  },
  {
    id: 'console',
    name: 'Console',
    label: 'Web UI',
    description:
      'Browser-based interface. Connect to your Claude instance from anywhere.',
    status: 'available',
  },
  {
    id: 'pulse',
    name: 'Pulse',
    label: 'Heartbeat',
    description:
      'Autonomous execution loop that works while you sleep. Executes roadmaps, solicits feedback, self-improves.',
    status: 'coming-soon',
  },
  {
    id: 'wing',
    name: 'Wing',
    label: 'Life Layer',
    description:
      'Your always-on AI companion. Remembers what matters, helps you plan, keeps you accountable, and gives AI agents persistent context about your goals and life.',
    status: 'coming-soon',
  },
  {
    id: 'channels',
    name: 'Channels',
    label: 'Integrations',
    description:
      'SMS, email, Telegram, Twitter. Agents that communicate outward.',
    status: 'coming-soon',
  },
  {
    id: 'mesh',
    name: 'Mesh',
    label: 'Agent Network',
    description:
      'The nervous system. Agents discover each other, share context, and coordinate across projects.',
    status: 'coming-soon',
  },
]
