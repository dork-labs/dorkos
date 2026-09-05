import { useState } from 'react';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { getSortedRowModel } from '@tanstack/react-table';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  DataTable,
  Badge,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  CAPABILITIES,
  MOCK_AGENTS,
  MOCK_ACTIVITIES,
  MOCK_TASK_RUNS,
  AGENT_COLUMNS,
  StatusBadge,
  ACTOR_STYLES,
  CATEGORY_STYLES,
  type MockActivity,
  type MockTaskRun,
} from './tables-showcase-data';

// ---------------------------------------------------------------------------
// Section 1: Basic Table
// ---------------------------------------------------------------------------

/** Basic HTML table with semantic markup. */
export function BasicTableSection() {
  return (
    <PlaygroundSection
      title="Basic Table"
      description="Raw Table primitives with semantic HTML — header, body, footer, and caption."
    >
      <ShowcaseLabel>Agent capabilities</ShowcaseLabel>
      <ShowcaseDemo>
        <Table>
          <TableCaption>Capabilities for the CodeReviewer agent.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Capability</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-[100px] text-center">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {CAPABILITIES.map((cap) => (
              <TableRow key={cap.capability}>
                <TableCell className="font-medium">{cap.capability}</TableCell>
                <TableCell className="text-muted-foreground">{cap.description}</TableCell>
                <TableCell className="text-center">
                  {cap.supported ? (
                    <Badge
                      variant="secondary"
                      className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    >
                      Supported
                    </Badge>
                  ) : (
                    <Badge tone="neutral" variant="secondary" className="bg-muted">
                      Planned
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={2}>Total capabilities</TableCell>
              <TableCell className="text-center">{CAPABILITIES.length}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// Section 2: Sortable Data Table
// ---------------------------------------------------------------------------

/** Data table with sortable column headers. */
export function SortableDataTableSection() {
  const [sorting, setSorting] = useState<SortingState>([]);

  return (
    <PlaygroundSection
      title="Sortable Data Table"
      description="TanStack Table with sortable column headers. Click Name, Namespace, or Sessions to sort."
    >
      <ShowcaseLabel>Agent fleet</ShowcaseLabel>
      <ShowcaseDemo>
        <DataTable
          columns={AGENT_COLUMNS}
          data={MOCK_AGENTS}
          tableOptions={{
            state: { sorting },
            onSortingChange: setSorting,
            getSortedRowModel: getSortedRowModel(),
          }}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// Section 3: Activity Log
// ---------------------------------------------------------------------------

const ACTIVITY_COLUMNS: ColumnDef<MockActivity>[] = [
  {
    accessorKey: 'time',
    header: 'Time',
    cell: ({ row }) => (
      <span className="text-muted-foreground w-20 text-xs tabular-nums">
        {row.getValue('time')}
      </span>
    ),
  },
  {
    accessorKey: 'actor',
    header: 'Actor',
    cell: ({ row }) => (
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
          ACTOR_STYLES[row.original.actorType]
        )}
      >
        {row.getValue('actor')}
      </span>
    ),
  },
  {
    accessorKey: 'category',
    header: 'Category',
    cell: ({ row }) => {
      const cat = row.getValue('category') as string;
      return (
        <span
          className={cn(
            'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize',
            CATEGORY_STYLES[cat]
          )}
        >
          {cat}
        </span>
      );
    },
  },
  {
    accessorKey: 'summary',
    header: 'Summary',
    cell: ({ row }) => (
      <span className="text-foreground/80 text-sm">{row.getValue('summary')}</span>
    ),
  },
];

/** Activity log in tabular format. */
export function ActivityLogSection() {
  return (
    <PlaygroundSection
      title="Activity Log"
      description="Activity events in tabular format with actor and category badges. Demonstrates how the activity feed maps to a data table."
    >
      <ShowcaseLabel>Recent activity</ShowcaseLabel>
      <ShowcaseDemo>
        <DataTable columns={ACTIVITY_COLUMNS} data={MOCK_ACTIVITIES} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// Section 4: Task Run History
// ---------------------------------------------------------------------------

const TASK_RUN_COLUMNS: ColumnDef<MockTaskRun>[] = [
  {
    accessorKey: 'taskName',
    header: 'Task',
    cell: ({ row }) => <span className="font-medium">{row.getValue('taskName')}</span>,
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.getValue('status')} />,
  },
  {
    accessorKey: 'startedAt',
    header: 'Started',
    cell: ({ row }) => (
      <span className="text-muted-foreground text-xs tabular-nums">
        {row.getValue('startedAt')}
      </span>
    ),
  },
  {
    accessorKey: 'duration',
    header: 'Duration',
    cell: ({ row }) => (
      <span className="font-mono text-xs tabular-nums">{row.getValue('duration')}</span>
    ),
  },
  {
    accessorKey: 'exitCode',
    header: 'Exit Code',
    cell: ({ row }) => {
      const code = row.getValue('exitCode') as number | null;
      if (code === null) return <span className="text-muted-foreground text-xs">—</span>;
      return (
        <span
          className={cn(
            'font-mono text-xs',
            code === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
          )}
        >
          {code}
        </span>
      );
    },
  },
];

/** Task run history with status badges and exit codes. */
export function TaskRunHistorySection() {
  return (
    <PlaygroundSection
      title="Task Run History"
      description="Scheduled task execution history with status badges, duration, and exit codes."
    >
      <ShowcaseLabel>Recent task runs</ShowcaseLabel>
      <ShowcaseDemo>
        <DataTable columns={TASK_RUN_COLUMNS} data={MOCK_TASK_RUNS} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
