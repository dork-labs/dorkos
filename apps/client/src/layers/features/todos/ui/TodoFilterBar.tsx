/**
 * The to-do list's controls: one chip per view, and a small menu for the due filter, the sort
 * and whether done ones show.
 *
 * @module features/todos/ui/TodoFilterBar
 */
import { ChevronDown } from 'lucide-react';
import {
  Chip,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/layers/shared/ui';
import {
  TODO_DUE_FILTERS,
  TODO_SORTS,
  TODO_VIEWS,
  type TodoDueFilter,
  type TodoSort,
} from '../lib/todo-labels';
import type { TodoFilters } from '../model/use-todo-filters';

/** Props for {@link TodoFilterBar}. */
export interface TodoFilterBarProps {
  /** What the list is showing. */
  filters: TodoFilters;
  /** Change one control. */
  onChange: <K extends keyof TodoFilters>(key: K, value: TodoFilters[K]) => void;
}

/** Whether a value is one of a list's own values. */
function isOneOf<T extends string>(options: readonly { value: T }[], value: string): value is T {
  return options.some((option) => option.value === value);
}

/** The view chips and the filter menu. */
export function TodoFilterBar({ filters, onChange }: TodoFilterBarProps) {
  const narrowed = filters.due !== 'any' || filters.sort !== 'due' || filters.showDone;
  return (
    <div data-slot="todo-filter-bar" className="flex flex-wrap items-center gap-1.5">
      <div role="group" aria-label="Whose to-dos" className="flex flex-wrap gap-1.5">
        {TODO_VIEWS.map((view) => (
          <Chip
            key={view.value}
            pressed={filters.view === view.value}
            onClick={() => onChange('view', view.value)}
          >
            {view.label}
          </Chip>
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip pressed={narrowed} aria-label="Filter and sort" icon={ChevronDown} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel>Due</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filters.due}
            onValueChange={(value) => {
              if (isOneOf<TodoDueFilter>(TODO_DUE_FILTERS, value)) onChange('due', value);
            }}
          >
            {TODO_DUE_FILTERS.map((due) => (
              <DropdownMenuRadioItem key={due.value} value={due.value}>
                {due.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Sort</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filters.sort}
            onValueChange={(value) => {
              if (isOneOf<TodoSort>(TODO_SORTS, value)) onChange('sort', value);
            }}
          >
            {TODO_SORTS.map((sort) => (
              <DropdownMenuRadioItem key={sort.value} value={sort.value}>
                {sort.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={filters.showDone}
            onCheckedChange={(checked) => onChange('showDone', checked === true)}
          >
            Show done
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
