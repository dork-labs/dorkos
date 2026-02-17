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
    id: 'vault',
    name: 'Vault',
    label: 'Knowledge',
    description:
      'Structured knowledge layer built on Obsidian. Projects, people, memory, strategic planning.',
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
]
