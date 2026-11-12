import type { ColumnDef } from '@tanstack/react-table';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Button,
  Skeleton,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

// ---------------------------------------------------------------------------
// Mock data types
// ---------------------------------------------------------------------------

export interface MockAgent {
  id: string;
  name: string;
  namespace: string;
  status: 'online' | 'offline' | 'busy';
  sessions: number;
  lastActive: string;
}

export interface MockActivity {
  id: string;
  time: string;
  actor: string;
  actorType: 'user' | 'agent' | 'system' | 'tasks';
  category: 'tasks' | 'relay' | 'agent' | 'config' | 'system';
  summary: string;
}

export interface MockTaskRun {
  id: string;
  taskName: string;
  status: 'success' | 'failed' | 'running' | 'skipped';
  startedAt: string;
  duration: string;
  exitCode: number | null;
}

export interface MockRelayMessage {
  id: string;
  time: string;
  adapter: string;
  direction: 'inbound' | 'outbound';
  subject: string;
  status: 'delivered' | 'pending' | 'failed';
}

export interface MockEndpoint {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  handler: string;
  latencyP50: string;
  latencyP99: string;
  rateLimit: string;
  status: 'healthy' | 'degraded' | 'down';
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

export const MOCK_AGENTS: MockAgent[] = [
  {
    id: 'dorkbot',
    name: 'DorkBot',
    namespace: 'system',
    status: 'online',
    sessions: 0,
    lastActive: '2 min ago',
  },
  {
    id: 'code-reviewer',
    name: 'CodeReviewer',
    namespace: 'dev',
    status: 'online',
    sessions: 3,
    lastActive: '5 min ago',
  },
  {
    id: 'research-agent',
    name: 'ResearchAgent',
    namespace: 'dev',
    status: 'busy',
    sessions: 1,
    lastActive: 'now',
  },
  {
    id: 'doc-writer',
    name: 'DocWriter',
    namespace: 'docs',
    status: 'offline',
    sessions: 0,
    lastActive: '2 hours ago',
  },
  {
    id: 'test-runner',
    name: 'TestRunner',
    namespace: 'ci',
    status: 'online',
    sessions: 5,
    lastActive: '12 min ago',
  },
  {
    id: 'deploy-bot',
    name: 'DeployBot',
    namespace: 'ci',
    status: 'offline',
    sessions: 0,
    lastActive: '1 day ago',
  },
];

export const MOCK_ACTIVITIES: MockActivity[] = [
  {
    id: '1',
    time: '2:14 AM',
    actor: 'You',
    actorType: 'user',
    category: 'agent',
    summary: 'Started session with CodeReviewer',
  },
  {
    id: '2',
    time: '2:00 AM',
    actor: 'Tasks',
    actorType: 'tasks',
    category: 'tasks',
    summary: 'Health check completed — all agents responding',
  },
  {
    id: '3',
    time: '1:45 AM',
    actor: 'System',
    actorType: 'system',
    category: 'relay',
    summary: 'Slack adapter connected successfully',
  },
  {
    id: '4',
    time: '1:30 AM',
    actor: 'You',
    actorType: 'user',
    category: 'config',
    summary: 'Updated default agent timeout to 300s',
  },
  {
    id: '5',
    time: '1:15 AM',
    actor: 'ResearchAgent',
    actorType: 'agent',
    category: 'agent',
    summary: 'Completed research report: API rate limiting patterns',
  },
  {
    id: '6',
    time: '1:00 AM',
    actor: 'System',
    actorType: 'system',
    category: 'system',
    summary: 'Server started on port 6242',
  },
  {
    id: '7',
    time: '12:45 AM',
    actor: 'TestRunner',
    actorType: 'agent',
    category: 'agent',
    summary: 'Ran 147 tests — 146 passed, 1 skipped',
  },
  {
    id: '8',
    time: '12:30 AM',
    actor: 'Tasks',
    actorType: 'tasks',
    category: 'tasks',
    summary: 'Daily summary generated and saved to ~/.dork/reports/',
  },
];

export const MOCK_TASK_RUNS: MockTaskRun[] = [
  {
    id: '1',
    taskName: 'Health Check',
    status: 'success',
    startedAt: '2:00 AM',
    duration: '2.3s',
    exitCode: 0,
  },
  {
    id: '2',
    taskName: 'Daily Summary',
    status: 'success',
    startedAt: '12:30 AM',
    duration: '45.1s',
    exitCode: 0,
  },
  {
    id: '3',
    taskName: 'Code Review',
    status: 'running',
    startedAt: '2:14 AM',
    duration: '—',
    exitCode: null,
  },
  {
    id: '4',
    taskName: 'Sync Docs',
    status: 'failed',
    startedAt: '12:15 AM',
    duration: '12.0s',
    exitCode: 1,
  },
  {
    id: '5',
    taskName: 'Cleanup Temp',
    status: 'skipped',
    startedAt: '—',
    duration: '—',
    exitCode: null,
  },
  {
    id: '6',
    taskName: 'Backup Config',
    status: 'success',
    startedAt: '12:00 AM',
    duration: '1.8s',
    exitCode: 0,
  },
];

export const MOCK_RELAY_MESSAGES: MockRelayMessage[] = [
  {
    id: '1',
    time: '14:23:01',
    adapter: 'slack',
    direction: 'inbound',
    subject: 'Deploy complete',
    status: 'delivered',
  },
  {
    id: '2',
    time: '14:22:58',
    adapter: 'slack',
    direction: 'outbound',
    subject: 'Starting deploy...',
    status: 'delivered',
  },
  {
    id: '3',
    time: '14:20:12',
    adapter: 'telegram',
    direction: 'inbound',
    subject: 'Review PR #142',
    status: 'delivered',
  },
  {
    id: '4',
    time: '14:19:30',
    adapter: 'email',
    direction: 'outbound',
    subject: 'Daily summary',
    status: 'pending',
  },
  {
    id: '5',
    time: '14:15:00',
    adapter: 'slack',
    direction: 'outbound',
    subject: 'Test results',
    status: 'failed',
  },
  {
    id: '6',
    time: '14:10:45',
    adapter: 'telegram',
    direction: 'outbound',
    subject: 'Agent alert',
    status: 'delivered',
  },
];

export const MOCK_ENDPOINTS: MockEndpoint[] = [
  {
    id: '1',
    method: 'GET',
    path: '/api/sessions',
    handler: 'SessionController.list',
    latencyP50: '12ms',
    latencyP99: '45ms',
    rateLimit: '100/min',
    status: 'healthy',
  },
  {
    id: '2',
    method: 'POST',
    path: '/api/sessions/:id/message',
    handler: 'MessageController.send',
    latencyP50: '340ms',
    latencyP99: '2.1s',
    rateLimit: '30/min',
    status: 'healthy',
  },
  {
    id: '3',
    method: 'GET',
    path: '/api/mesh/topology',
    handler: 'MeshController.topology',
    latencyP50: '28ms',
    latencyP99: '120ms',
    rateLimit: '60/min',
    status: 'degraded',
  },
  {
    id: '4',
    method: 'DELETE',
    path: '/api/agents/:id',
    handler: 'AgentController.unregister',
    latencyP50: '8ms',
    latencyP99: '35ms',
    rateLimit: '10/min',
    status: 'healthy',
  },
  {
    id: '5',
    method: 'PUT',
    path: '/api/pulse/schedules/:id',
    handler: 'PulseController.update',
    latencyP50: '15ms',
    latencyP99: '90ms',
    rateLimit: '20/min',
    status: 'down',
  },
];

// ---------------------------------------------------------------------------
// Style maps
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  online: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  offline: 'bg-neutral-500/10 text-neutral-500',
  busy: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
  running: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  skipped: 'bg-neutral-500/10 text-neutral-500',
  delivered: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

export const CATEGORY_STYLES: Record<string, string> = {
  tasks: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
  relay: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  agent: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  config: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  system: 'bg-neutral-500/10 text-neutral-500',
};

export const ACTOR_STYLES: Record<string, string> = {
  user: 'bg-muted text-muted-foreground',
  agent: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  system: 'bg-neutral-500/10 text-neutral-500',
  tasks: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
};

export const METHOD_COLORS: Record<string, string> = {
  GET: 'text-blue-500',
  POST: 'text-emerald-500',
  PUT: 'text-amber-500',
  DELETE: 'text-red-500',
};

// ---------------------------------------------------------------------------
// Shared helper components
// ---------------------------------------------------------------------------

/** Status badge used across multiple showcase sections. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize',
        STATUS_STYLES[status] ?? 'bg-muted text-muted-foreground'
      )}
    >
      {status}
    </span>
  );
}

/** Sortable column header with directional icon. */
function SortableHeader({
  column,
  children,
}: {
  column: { getIsSorted: () => false | 'asc' | 'desc'; toggleSorting: () => void };
  children: React.ReactNode;
}) {
  const sorted = column.getIsSorted();
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;

  return (
    <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => column.toggleSorting()}>
      {children}
      <Icon className="ml-1 size-3.5" />
    </Button>
  );
}

/** Skeleton loading state for tables. */
export function TableSkeleton() {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Skeleton className="h-4 w-20" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-24" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-20" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 4 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-28" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-14 rounded-md" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared column definitions (used by multiple sections)
// ---------------------------------------------------------------------------

export const AGENT_COLUMNS: ColumnDef<MockAgent>[] = [
  {
    accessorKey: 'name',
    header: ({ column }) => <SortableHeader column={column}>Name</SortableHeader>,
    cell: ({ row }) => <span className="font-medium">{row.getValue('name')}</span>,
  },
  {
    accessorKey: 'namespace',
    header: ({ column }) => <SortableHeader column={column}>Namespace</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-muted-foreground font-mono text-xs">{row.getValue('namespace')}</span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.getValue('status')} />,
  },
  {
    accessorKey: 'sessions',
    header: ({ column }) => <SortableHeader column={column}>Sessions</SortableHeader>,
    cell: ({ row }) => <span className="tabular-nums">{row.getValue('sessions')}</span>,
  },
  {
    accessorKey: 'lastActive',
    header: 'Last Active',
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs">{row.getValue('lastActive')}</span>
    ),
  },
];

/** Capabilities data for the basic table section. */
export const CAPABILITIES = [
  {
    capability: 'Code Review',
    description: 'Analyze PRs for bugs, style, and security issues',
    supported: true,
  },
  {
    capability: 'Test Generation',
    description: 'Generate unit and integration tests from source',
    supported: true,
  },
  {
    capability: 'Refactoring',
    description: 'Restructure code while preserving behavior',
    supported: true,
  },
  {
    capability: 'Documentation',
    description: 'Write TSDoc, README, and architecture docs',
    supported: true,
  },
  {
    capability: 'Deployment',
    description: 'Build, deploy, and promote via Vercel CLI',
    supported: false,
  },
  { capability: 'Monitoring', description: 'Watch logs and alert on anomalies', supported: false },
];
