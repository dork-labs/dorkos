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
      'The Mesh turns folders into agents with their own rules and memory. They discover each other, share context, and coordinate — your scheduling agent talks to your finance agent talks to your purchasing agent.',
  },
  {
    id: 'life-layer',
    title: 'Your life, always in context',
    description:
      'Wing is your personal life layer — a memory system, life coach, and chief of staff that gives agents persistent context about your goals, commitments, and priorities.',
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
