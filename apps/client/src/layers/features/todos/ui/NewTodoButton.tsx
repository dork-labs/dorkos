/**
 * The To-dos bar's one write action: New to-do. Words on a desktop, a square `+` on a phone, named
 * the same at both widths. Hidden while to-dos are off.
 *
 * @module features/todos/ui/NewTodoButton
 */
import { Plus } from 'lucide-react';
import { useTodosEnabled } from '@/layers/entities/todo';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { openNewTodo } from '../model/make-todo';

/** New to-do, for the To-dos page's bar. */
export function NewTodoButton() {
  const enabled = useTodosEnabled();
  const isMobile = useIsMobile();
  if (!enabled) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={openNewTodo}
      aria-label={isMobile ? 'New to-do' : undefined}
      // Squared to the bar's tab height on a phone, as Team's New agent is, so the bar's only
      // write action is never its smallest target.
      className={cn(isMobile && 'h-[35px] w-[35px] p-0')}
    >
      <Plus aria-hidden />
      {!isMobile && 'New to-do'}
    </Button>
  );
}
