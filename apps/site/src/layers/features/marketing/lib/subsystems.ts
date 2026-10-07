export interface Subsystem {
  id: string;
  name: string;
  /** One-line, user-facing benefit — published in llms.txt. */
  benefit: string;
}

export const subsystems: Subsystem[] = [
  {
    id: 'console',
    name: 'Console',
    benefit: 'Ask for a tool and your agents build it. Talk with them in channels and DMs.',
  },
  {
    id: 'tasks',
    name: 'Tasks',
    benefit: 'Hand off the work. It runs on a schedule.',
  },
  {
    id: 'relay',
    name: 'Relay',
    benefit: 'Your agents can reach you anywhere.',
  },
  {
    id: 'mesh',
    name: 'Mesh',
    benefit: 'Your agents find each other.',
  },
];
