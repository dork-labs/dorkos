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
    ceiling: 'Still had to be awake for any of it to run.',
    color: 'charcoal',
  },
  {
    step: 3,
    product: 'Pulse',
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

export const futureCards: FutureCard[] = [
  {
    id: 'autonomous',
    label: 'Autonomous',
    title: 'Agents that run',
    description: 'Pulse. Already shipping. Your agents work while you sleep.',
    color: 'orange',
  },
  {
    id: 'connected',
    label: 'Connected',
    title: 'Agents that talk',
    description: 'Mesh. Agent-to-agent discovery and coordination across teams.',
    color: 'blue',
  },
  {
    id: 'commerce',
    label: 'Commerce',
    title: 'Agents that transact',
    description: 'HTTP 402. Agents negotiate, purchase, settle. The economy reshapes.',
    color: 'green',
  },
];
