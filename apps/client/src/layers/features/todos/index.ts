/**
 * To-dos as a person works them (DOR-3088): the list with its four views and filters, one row
 * per to-do completed in place with a moment to undo, and the New to-do dialog. Also each agent's own promises (spec `heartbeats` §12), open first with
 * overdue ones marked, with the controls to keep one, drop it, or add one for an agent.
 *
 * @module features/todos
 */
export { TodoList, type TodoListProps } from './ui/TodoList';
export { TodoRow, type TodoRowProps } from './ui/TodoRow';
export { NewTodoDialog, type NewTodoDialogProps } from './ui/NewTodoDialog';
export { titleFromMessage, type TodoMessageSource } from './ui/NewTodoDialog';
export { MakeTodoDialog, type MakeTodoDialogProps } from './ui/MakeTodoDialog';
export {
  makeTodoDialogState,
  openMakeTodo,
  openNewTodo,
  useMakeTodoAction,
} from './model/make-todo';
export { NewTodoButton } from './ui/NewTodoButton';
export { TodoCard, type TodoCardProps } from './ui/TodoCard';
export { TodoPromiseList, type TodoPromiseListProps } from './ui/TodoPromiseList';
export { TodoPromiseRow, type TodoPromiseRowProps } from './ui/TodoPromiseRow';
export { AddTodoForm, type AddTodoFormProps } from './ui/AddTodoForm';
export { dueLabel, rosterNameLookup, splitTodos, toLabel } from './lib/todo-promise-labels';
