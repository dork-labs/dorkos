import type { Todo } from '@dorkos/shared/todo-schemas';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { TodoRow } from '@/layers/features/todos';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const DAY_MS = 86_400_000;

/** Every row starts from this and changes what its state is about. */
const BASE: Todo = {
  id: 'todo-showcase',
  what: 'Send the March invoice to Acme',
  assignee: { kind: 'person', account: 'owner' },
  assignedBy: { kind: 'person', id: 'owner' },
  to: null,
  dueAt: null,
  state: 'open',
  overdue: false,
  roomId: null,
  sourceEntryId: null,
  sourceAuthor: null,
  titleFromSource: false,
  notes: null,
  note: null,
  rank: null,
  chainDepth: 0,
  strangerBound: false,
  createdAt: '2026-11-01T09:00:00.000Z',
  closedAt: null,
};

const SCOUT: AgentPathEntry = {
  id: 'agent-scout',
  name: 'scout',
  displayName: 'Scout',
  projectPath: '/Users/you/code/scout',
  color: '#0ea5e9',
  icon: '🔭',
};

const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

const ROWS: { label: string; todo: Todo; agent?: AgentPathEntry; from: string; room?: string }[] = [
  { label: 'Open, due in a few days', todo: { ...BASE, dueAt: inDays(3) }, from: 'you' },
  {
    label: 'Overdue, on an agent',
    todo: {
      ...BASE,
      id: 'todo-overdue',
      what: 'Draft the onboarding email sequence',
      assignee: { kind: 'agent', agentId: SCOUT.id },
      dueAt: inDays(-1),
      overdue: true,
    },
    agent: SCOUT,
    from: 'you',
    room: '#launch',
  },
  {
    label: 'Declined, with its reason',
    todo: {
      ...BASE,
      id: 'todo-declined',
      what: 'Book the venue for the meetup',
      assignee: { kind: 'agent', agentId: SCOUT.id },
      state: 'dropped',
      note: 'No booking access',
    },
    agent: SCOUT,
    from: 'you',
  },
  {
    label: 'From a guest, at a guest’s limits',
    todo: {
      ...BASE,
      id: 'todo-limited',
      what: 'Reply to the partnership question',
      assignedBy: { kind: 'outsider', id: 'telegram:ana' },
      strangerBound: true,
    },
    from: 'a guest',
  },
  {
    label: 'Title in the source’s own words',
    todo: {
      ...BASE,
      id: 'todo-words',
      what: 'can someone check the pricing page typo',
      assignedBy: { kind: 'agent', id: SCOUT.id },
      sourceAuthor: 'Ana',
      titleFromSource: true,
    },
    from: 'Scout',
    room: '#general',
  },
];

/** To-do rows in each state a list draws (DOR-3088). */
export function TodosShowcases() {
  return (
    <PlaygroundSection
      title="To-do rows"
      description="One row per to-do: the check circle, when it is due, who has it, and where it came from."
    >
      {ROWS.map((row) => (
        <div key={row.todo.id}>
          <ShowcaseLabel>{row.label}</ShowcaseLabel>
          <ShowcaseDemo responsive>
            <ul>
              <TodoRow
                todo={row.todo}
                from={row.from}
                {...(row.agent ? { agent: row.agent } : {})}
                {...(row.room ? { roomTitle: row.room } : {})}
                {...(row.todo.state === 'open' ? { onComplete: () => {} } : {})}
              />
            </ul>
          </ShowcaseDemo>
        </div>
      ))}
      <ShowcaseLabel>Just completed, with Undo</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ul>
          <TodoRow
            todo={{ ...BASE, id: 'todo-done', state: 'kept' }}
            from="you"
            onUndo={() => {}}
          />
        </ul>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
