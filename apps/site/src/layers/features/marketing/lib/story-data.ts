/** Boot card displayed in the MondayMorningSection grid. */
export interface BootCard {
  id: string
  label: string
  value: string
  detail: string
  /** Design token color name for the border accent. */
  color: 'orange' | 'blue' | 'purple' | 'green' | 'gray'
  /** Whether the card has an urgent/flagged treatment. */
  urgent?: boolean
}

/** One step in the LifeOS -> DorkOS evolution timeline. */
export interface EvolutionStep {
  step: number
  product: string
  duration: string
  description: string
  /** What limitation drove the next step. Null for the final step. */
  ceiling: string | null
  /** Design token color for the step number circle. */
  color: 'orange' | 'charcoal'
}

/** One line in the "platforms will just be prompts" equation. */
export interface EquationItem {
  lhs: string
  rhs: string
}

/** One card in the FutureVisionSection. */
export interface FutureCard {
  id: string
  label: string
  title: string
  description: string
  color: 'orange' | 'blue' | 'green'
}

export const bootCards: BootCard[] = [
  { id: 'health', label: 'Health', value: 'Synced', detail: 'HRV · sleep · steps', color: 'orange' },
  { id: 'companies', label: 'Companies', value: '4 loaded', detail: 'tasks · projects', color: 'blue' },
  { id: 'overdue', label: '⚑ Overdue', value: '2 days', detail: 'flagged for you', color: 'orange', urgent: true },
  { id: 'calendar', label: 'Calendar', value: '3 preps', detail: 'meetings identified', color: 'purple' },
  { id: 'vacation', label: 'Vacation', value: 'Planned', detail: 'dates · itinerary set', color: 'blue' },
  { id: 'coaching', label: 'Coaching', value: 'Fear check', detail: 'priorities → 3', color: 'orange' },
  { id: 'comms', label: 'Comms', value: '7 drafted', detail: 'replies · emails · staged', color: 'purple' },
  { id: 'output', label: 'Output', value: 'Ready', detail: 'calendar · habits · audio', color: 'gray' },
]

export const evolutionSteps: EvolutionStep[] = [
  {
    step: 1,
    product: 'LifeOS',
    duration: 'A weekend',
    description: 'Calendar, todos, journaling, coaching. Built for my life -- not for any company.',
    ceiling: 'Needed to manage multiple AI projects at once.',
    color: 'orange',
  },
  {
    step: 2,
    product: 'DorkOS',
    duration: 'A few weeks',
    description: 'A command layer across all my agents. One place to run everything.',
    ceiling: 'Still had to be awake for any of it to run.',
    color: 'charcoal',
  },
  {
    step: 3,
    product: 'Pulse',
    duration: 'A few weeks',
    description: 'Scheduled tasks. The system fires overnight. Texts briefings before I wake up.',
    ceiling: "Agents couldn't talk to each other.",
    color: 'charcoal',
  },
  {
    step: 4,
    product: 'Mesh',
    duration: 'A few weeks',
    description: 'Four companies, each with its own agent. They find each other and coordinate.',
    ceiling: null,
    color: 'charcoal',
  },
]

export const equationItems: EquationItem[] = [
  { lhs: '50+ skills', rhs: 'text files' },
  { lhs: '~100 coaching Qs', rhs: 'one markdown doc' },
  { lhs: 'board of advisors', rhs: 'configuration' },
  { lhs: 'automated hooks', rhs: 'small scripts' },
]

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
]
