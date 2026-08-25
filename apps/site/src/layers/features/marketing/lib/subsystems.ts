export interface Subsystem {
  id: string;
  name: string;
  /** One-line, user-facing benefit — shown in the PivotSection reveal grid and llms.txt. */
  benefit: string;
}

export const subsystems: Subsystem[] = [
  {
    id: 'tasks',
    name: 'Tasks',
    benefit: 'Hand off the work. It runs on schedule.',
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
  {
    id: 'console',
    name: 'Console',
    benefit: 'See and steer every agent you run.',
  },
];
