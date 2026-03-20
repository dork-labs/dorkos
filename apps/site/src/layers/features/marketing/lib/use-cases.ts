export interface UseCase {
  id: string;
  title: string;
  description: string;
}

export const useCases: UseCase[] = [
  {
    id: 'ship-while-you-sleep',
    title: 'Ship around the clock',
    description: 'Pulse executes your roadmap autonomously. Wake up to PRs, not TODO lists.',
  },
  {
    id: 'agents-that-talk',
    title: 'Agents that talk to each other',
    description:
      'Mesh turns projects into agents with their own rules and memory. They discover each other, share context, and coordinate — your scheduling agent talks to your finance agent talks to your purchasing agent.',
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
      'Console gives you a browser-based command center. Chat with agents, manage schedules, and control your system from any device.',
  },
  {
    id: 'your-rules',
    title: 'Your rules, your permissions',
    description:
      'Tool approval flows, session management, slash commands. Full control without sacrificing power.',
  },
  {
    id: 'continuous-improvement',
    title: 'AI that improves itself',
    description:
      'Loop closes the feedback loop — turning signals into hypotheses, hypotheses into tasks, and outcomes into the next iteration. Your system gets better on its own.',
  },
];
