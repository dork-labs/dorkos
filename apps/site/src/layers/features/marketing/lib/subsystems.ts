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
    benefit: 'Talk with your agents in channels, DMs and threads.',
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
