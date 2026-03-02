export interface Subsystem {
  id: string
  benefit: string
  name: string
  description: string
  status: 'available' | 'coming-soon'
}

export const subsystems: Subsystem[] = [
  {
    id: 'pulse',
    benefit: 'Makes agents work autonomously',
    name: 'Pulse',
    description: 'Tell your agents what to do and when to do it, and they\'ll handle the rest.',
    status: 'available',
  },
  {
    id: 'relay',
    benefit: 'Delivers messages between agents and humans',
    name: 'Relay',
    description:
      'Telegram, Slack, email, etc. You can chat with your agents wherever you are.',
    status: 'available',
  },
  {
    id: 'mesh',
    benefit: 'Connects agents to each other',
    name: 'Mesh',
    description: 'Your agents find each other and divide the work without you in the middle.',
    status: 'available',
  },
  {
    id: 'console',
    benefit: 'Dashboard to chat and and control all aspects of DorkOS',
    name: 'Console',
    description: 'Chat with your agents, create new agents, manage schedules, and more.',
    status: 'available',
  },
  {
    id: 'loop',
    benefit: 'Continuous improvement engine',
    name: 'Loop',
    description: 'Your agents spot what\u2019s working, test new ideas, and improve over time.',
    status: 'available',
  },
  {
    id: 'wing',
    benefit: 'Your personal productivity pack',
    name: 'Wing',
    description: 'Your agents keep context across sessions. Nothing gets forgotten.',
    status: 'coming-soon',
  },
]
