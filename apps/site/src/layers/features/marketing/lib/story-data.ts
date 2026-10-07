/** Boot card displayed in the MondayMorningSection grid. */
export interface BootCard {
  id: string;
  label: string;
  value: string;
  detail: string;
  /** Design token color name for the border accent. */
  color: 'orange' | 'blue' | 'purple' | 'green' | 'gray';
  /** Whether the card has an urgent/flagged treatment. */
  urgent?: boolean;
}

/** One step in the LifeOS -> DorkOS evolution timeline. */
export interface EvolutionStep {
  step: number;
  product: string;
  duration: string;
  description: string;
  /** What limitation drove the next step. Null for the final step. */
  ceiling: string | null;
  /** Design token color for the step number circle. */
  color: 'orange' | 'charcoal';
}

/** One line in the "platforms will just be prompts" equation. */
export interface EquationItem {
  lhs: string;
  rhs: string;
}

/** One card in the FutureVisionSection. */
export interface FutureCard {
  id: string;
  label: string;
  title: string;
  description: string;
  color: 'orange' | 'blue' | 'green';
}

export const bootCards: BootCard[] = [
  {
    id: 'talk',
    label: 'This Talk',
    value: 'Outlined',
    detail: 'No Edges · draft outline',
    color: 'orange',
  },
  {
    id: 'comms',
    label: 'Comms',
    value: 'Drafted',
    detail: 'slack · email · iMessage',
    color: 'purple',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    value: 'Timeboxed',
    detail: 'meetings briefed',
    color: 'blue',
  },
  {
    id: 'todos',
    label: 'Tasks',
    value: 'Planned',
    detail: 'ready to start',
    color: 'orange',
    urgent: true,
  },
];

export const evolutionSteps: EvolutionStep[] = [
  {
    step: 1,
    product: 'LifeOS',
    duration: 'A weekend',
    description: 'Calendar, coaching, journaling. Built for my life, not work.',
    ceiling: 'Projects multiplied. Needed one command layer.',
    color: 'orange',
  },
  {
    step: 2,
    product: 'DorkOS',
    duration: 'A few weeks',
    description: 'One command layer across all my agents.',
    ceiling: 'Still had to kick off every single run myself.',
    color: 'charcoal',
  },
  {
    step: 3,
    product: 'Tasks',
    duration: 'A few weeks',
    description: 'Scheduled agents. Runs overnight. Morning brief before I wake up.',
    ceiling: "Agents couldn't talk to each other.",
    color: 'charcoal',
  },
  {
    step: 4,
    product: 'Mesh',
    duration: 'A few weeks',
    description: 'Agents that find each other. Three companies, one network.',
    ceiling: null,
    color: 'charcoal',
  },
];

export const equationItems: EquationItem[] = [
  { lhs: '50+ skills', rhs: 'text files' },
  { lhs: '~100 coaching Qs', rhs: 'one markdown doc' },
  { lhs: 'board of advisors', rhs: 'configuration' },
  { lhs: 'automated hooks', rhs: 'small scripts' },
];

/**
 * The three differentiators, in the order the 2026-10-06 positioning fixes.
 * Each card says plainly what ships today; goals, business connections and
 * ready-made founder mini apps are roadmap, so that card says "Coming next".
 */
export const futureCards: FutureCard[] = [
  {
    id: 'mini-apps',
    label: 'Mini apps',
    title: 'Agents that build your tools',
    description:
      'Already shipping. Ask for a dashboard or a tracker. Your agents build it inside DorkOS, and it opens once you say yes.',
    color: 'orange',
  },
  {
    id: 'founders',
    label: 'For founders',
    title: 'Built to run a business',
    description:
      'Made for founders who run a business mostly with agents. Coming next: goals, business connections, and ready-made mini apps.',
    color: 'blue',
  },
  {
    id: 'ownership',
    label: 'Ownership',
    title: 'Yours to keep',
    description:
      'Already shipping. Your computer, your files, your AI plan. Open source and free forever.',
    color: 'green',
  },
];
