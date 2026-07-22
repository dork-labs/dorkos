import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { SearchX } from 'lucide-react';
import type { Task } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { applySortAndFilter } from '@/layers/shared/lib';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { useFilterState } from '@/layers/shared/model';
import { FilterBar } from '@/layers/shared/ui/filter-bar';
import { Skeleton } from '@/layers/shared/ui/skeleton';
import { ScrollArea } from '@/layers/shared/ui/scroll-area';
import { Button } from '@/layers/shared/ui/button';
import { taskFilterSchema, taskSortOptions } from '../lib/task-filter-schema';
import { TaskRow } from './TaskRow';

/** Items beyond this index are rendered without stagger delay to keep animation snappy. */
const STAGGER_ITEM_LIMIT = 8;

/** Stagger container variants -- orchestrates child entrance animations. */
const staggerContainerVariants = {
  visible: { transition: { staggerChildren: 0.04 } },
  hidden: {},
} as const;

/** Item entrance variants -- fade in + slide up for the first N items. */
const staggerItemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
} as const;

interface TasksListProps {
  tasks: Task[];
  isLoading: boolean;
  /** Map from agent ID to resolved agent manifest. */
  agentMap: Map<string, AgentManifest>;
  /** Called when the user wants to edit a task. */
  onEditTask: (task: Task) => void;
  /** Pre-filter tasks by agent ID (e.g. when shown in an agent-scoped dialog). */
  agentId?: string;
}

/**
 * Task list container -- renders expandable TaskRow components with
 * composable filter bar, sort options, and entrance animations.
 */
export function TasksList({ tasks, isLoading, agentMap, onEditTask, agentId }: TasksListProps) {
  const filterState = useFilterState(taskFilterSchema, {
    debounce: { search: 200 },
  });
  // staggerKey is intentionally never updated -- keeping it stable prevents the
  // stagger container from remounting (and re-animating) on filter changes.
  const [staggerKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Pre-filter by agent when agentId is provided
  const baseTasks = useMemo(
    () => (agentId ? tasks.filter((t) => t.agentId === agentId) : tasks),
    [tasks, agentId]
  );

  // Derive dynamic agent options from the task list
  const agentOptions = useMemo(
    () => [...new Set(baseTasks.map((t) => t.agentId).filter((id): id is string => Boolean(id)))],
    [baseTasks]
  );

  // Apply filters and sort
  const filteredTasks = useMemo(
    () =>
      applySortAndFilter(baseTasks, taskFilterSchema, filterState.values, taskSortOptions, {
        field: filterState.sortField,
        direction: filterState.sortDirection,
      }),
    [baseTasks, filterState.values, filterState.sortField, filterState.sortDirection]
  );

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar state={filterState}>
        <FilterBar.Search placeholder="Filter tasks..." />
        <FilterBar.Primary name="status" />
        <FilterBar.AddFilter dynamicOptions={{ agent: agentOptions }} />
        <FilterBar.Sort options={taskSortOptions} />
        <FilterBar.ResultCount count={filteredTasks.length} total={baseTasks.length} noun="task" />
        <FilterBar.ActiveFilters />
      </FilterBar>
      <ScrollArea className="min-h-0 flex-1" data-testid={TOUR_ANCHORS.tasksList}>
        <div className="space-y-2 p-4 pt-0">
          {filteredTasks.length === 0 && baseTasks.length > 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="flex flex-col items-center justify-center gap-3 py-12 text-center"
            >
              <SearchX className="text-muted-foreground/50 size-10" />
              <p className="text-muted-foreground text-sm">
                {filterState.describeActive()
                  ? `No tasks match ${filterState.describeActive()}`
                  : 'No tasks match your filters'}
              </p>
              <Button variant="outline" size="sm" onClick={filterState.clearAll}>
                Clear filters
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key={staggerKey}
              initial="hidden"
              animate="visible"
              variants={staggerContainerVariants}
              className="space-y-2"
            >
              {filteredTasks.map((task, index) => (
                <motion.div
                  key={task.id}
                  variants={index < STAGGER_ITEM_LIMIT ? staggerItemVariants : undefined}
                  transition={{ duration: 0.15 }}
                >
                  <TaskRow
                    task={task}
                    agent={(task.agentId ? agentMap.get(task.agentId) : undefined) ?? null}
                    expanded={expandedId === task.id}
                    onToggleExpand={() => setExpandedId(expandedId === task.id ? null : task.id)}
                    onEdit={() => onEditTask(task)}
                  />
                </motion.div>
              ))}
            </motion.div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
