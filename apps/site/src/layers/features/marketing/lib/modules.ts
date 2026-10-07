export interface SystemModule {
  id: string;
  name: string;
  label: string;
  description: string;
  status: 'available' | 'coming-soon';
  group: 'platform' | 'engine-capability' | 'extension';
  /** External URL for modules with their own website (opens in new tab). */
  url?: string;
}

export const systemModules: SystemModule[] = [
  {
    id: 'engine',
    name: 'Engine',
    label: 'Runtime',
    description:
      'The server underneath it all. Connects your agents to their AI tools, listens only on your own machine by default, and runs Tasks, Relay and Mesh.',
    status: 'available',
    group: 'platform',
  },
  {
    id: 'console',
    name: 'Console',
    label: 'Interface',
    description:
      'The app you work in. Ask your agents for mini apps, talk with them in channels and DMs, and open it from any browser.',
    status: 'available',
    group: 'platform',
  },
  {
    id: 'tasks',
    name: 'Tasks',
    label: 'Scheduler',
    description:
      'Work that runs on a schedule while you are away. Your agents start on time and tell you when they finish.',
    status: 'available',
    group: 'engine-capability',
  },
  {
    id: 'relay',
    name: 'Relay',
    label: 'Message Bus',
    description:
      'How messages move. One format for agents, people and outside apps, with limits that stop runaway loops.',
    status: 'available',
    group: 'engine-capability',
  },
  {
    id: 'mesh',
    name: 'Mesh',
    label: 'Agent Network',
    description:
      'How agents find each other. Mesh finds the agents in your projects and lists them, so they can message each other.',
    status: 'available',
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
      'Closes the feedback loop. Turns signals into hypotheses, hypotheses into tasks, and outcomes into the next iteration. Your system gets better while you’re not looking.',
    status: 'available',
    group: 'extension',
    url: 'https://www.looped.me/',
  },
];
