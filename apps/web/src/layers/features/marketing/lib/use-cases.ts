export interface UseCase {
  id: string
  title: string
  description: string
}

export const useCases: UseCase[] = [
  {
    id: 'ship-while-you-sleep',
    title: 'Ship while you sleep',
    description:
      'The Heartbeat executes your roadmap autonomously. Wake up to PRs, not TODO lists.',
  },
  {
    id: 'agents-that-talk',
    title: 'Agents that talk to each other',
    description:
      'Multiple Claude instances coordinating across projects. Agent-to-agent communication for complex workflows.',
  },
  {
    id: 'brain-that-remembers',
    title: 'A brain that remembers everything',
    description:
      'The Vault gives your agents persistent memory, context, and strategic awareness through Obsidian.',
  },
  {
    id: 'access-from-anywhere',
    title: 'Access from anywhere',
    description:
      'Browser UI + tunnel. Your full dev environment from any device, any browser.',
  },
  {
    id: 'your-rules',
    title: 'Your rules, your permissions',
    description:
      'Tool approval flows, session management, slash commands. Full control without sacrificing power.',
  },
  {
    id: 'works-with-cli',
    title: 'Works with the CLI you already use',
    description:
      'Same JSONL transcripts, same sessions. DorkOS adds a layer on top, never replaces what works.',
  },
]
