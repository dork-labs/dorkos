/**
 * The New to-do dialog, started from the message it was opened for (`openMakeTodo`). The root
 * dialog host mounts it only while it is open.
 *
 * @module features/todos/ui/MakeTodoDialog
 */
import { makeTodoSource } from '../model/make-todo';
import { NewTodoDialog } from './NewTodoDialog';

/** Props the root dialog host passes. */
export interface MakeTodoDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog asks to close. */
  onOpenChange: (open: boolean) => void;
}

/** "Make a to-do", from the message it was opened for. */
export function MakeTodoDialog({ open, onOpenChange }: MakeTodoDialogProps) {
  const source = makeTodoSource();
  return <NewTodoDialog open={open} onOpenChange={onOpenChange} {...(source ? { source } : {})} />;
}
