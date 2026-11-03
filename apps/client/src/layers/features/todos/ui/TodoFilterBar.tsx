/**
 * The to-do list's controls: one chip per view, and a small menu for the due filter, the sort
 * and whether done ones show. One row at every width: the chips scroll sideways on a phone, and
 * the menu stays at the row's end.
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
    <div data-slot="todo-filter-bar" className="flex min-w-0 items-center gap-1.5">
      <div
        role="group"
        aria-label="Whose to-dos"
        // The padding keeps the chips' focus rings inside the scroller, which clips both ways.
        // On a phone the row fades out at its right edge, so a chip half out of view reads as
        // "there's more this way" rather than as cut off (DOR-3715).
        className="-my-1 flex min-w-0 scrollbar-none gap-1.5 overflow-x-auto px-0.5 py-1 max-md:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] max-md:pr-6"
      >
        {TODO_VIEWS.map((view) => (
          <Chip
            key={view.value}
            className="shrink-0"
            pressed={filters.view === view.value}
            onClick={() => onChange('view', view.value)}
          >
            {view.label}
          </Chip>
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip
            pressed={narrowed}
            aria-label="Filter and sort"
            icon={ChevronDown}
            className="shrink-0"
          />
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
