/**
 * "New to-do": a title, who it is for (you or one of your agents), and an optional date. A
 * dialog on a desktop, a bottom sheet on a phone. Enter adds it. Made from a message, it starts
 * from the message's first line and names the message, so the server reads who wrote it.
 *
 * A window without the owner's sign-in is asked for it by the app's own `fetch`, and the add
 * goes again once they sign in; a failure toasts from the shared mutation handler.
 *
 * @module features/todos/ui/NewTodoDialog
 */
import { useId, useState, type FormEvent } from 'react';
import { COMMITMENT_WHAT_MAX } from '@dorkos/shared/commitment-schemas';
import type { CreateTodoRequest, TodoAssignee } from '@dorkos/shared/todo-schemas';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useCreateTodo } from '@/layers/entities/todo';
import { getAgentDisplayName } from '@/layers/shared/lib';
import {
  Button,
  Input,
  Label,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { endOfLocalDayIso } from '../lib/todo-labels';

/** The picker's value for the person. Agent ids never collide with it: they are ULIDs. */
const YOU = 'you';

/** The person's own account; the only person a to-do is assigned to today. */
const OWNER_ACCOUNT = 'owner';

/** Props for {@link NewTodoDialog}. */
export interface NewTodoDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog asks to close. */
  onOpenChange: (open: boolean) => void;
  /** The message this to-do is made from, when it is. */
  source?: TodoMessageSource;
}

/** A message a to-do is made from: its id, for the server, and its words, for the title. */
export interface TodoMessageSource {
  /** The room entry's id. */
  entryId: string;
  /** The message's text. */
  text: string;
}

/**
 * A message's first non-empty line, cut to the longest title a to-do takes.
 *
 * @param text - The message's text.
 */
export function titleFromMessage(text: string): string {
  const line = text.split('\n').find((part) => part.trim().length > 0) ?? '';
  return line.trim().slice(0, COMMITMENT_WHAT_MAX);
}

/** Who the picker's value names. */
function assigneeOf(value: string): TodoAssignee {
  return value === YOU
    ? { kind: 'person', account: OWNER_ACCOUNT }
    : { kind: 'agent', agentId: value };
}

/** The body a filled form sends. */
function createTodoBody(
  what: string,
  assignee: string,
  due: string,
  source: TodoMessageSource | undefined
): CreateTodoRequest {
  const dueAt = due ? endOfLocalDayIso(due) : null;
  return {
    what: what.trim(),
    assignee: assigneeOf(assignee),
    ...(dueAt ? { dueAt } : {}),
    ...(source ? { sourceEntryId: source.entryId } : {}),
  };
}

/** The form itself, mounted fresh each time the dialog opens. */
function NewTodoForm({ onDone, source }: { onDone: () => void; source?: TodoMessageSource }) {
  const ids = useId();
  const [what, setWhat] = useState(() => (source ? titleFromMessage(source.text) : ''));
  const [assignee, setAssignee] = useState(YOU);
  const [due, setDue] = useState('');
  const create = useCreateTodo();
  const { data: agentsData } = useMeshAgentPaths();
  const agents = agentsData?.agents ?? [];
  const canAdd = what.trim().length > 0 && !create.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canAdd) return;
    create.mutate(createTodoBody(what, assignee, due, source), { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} className="contents">
      <ResponsiveDialogBody className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-what`}>To-do</Label>
          <Input
            id={`${ids}-what`}
            value={what}
            maxLength={COMMITMENT_WHAT_MAX}
            required
            autoFocus
            placeholder="Send the March invoice"
            onChange={(event) => setWhat(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-who`}>For</Label>
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger id={`${ids}-who`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={YOU}>You</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {getAgentDisplayName(agent)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-due`}>Due (optional)</Label>
          <Input
            id={`${ids}-due`}
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
          />
        </div>
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canAdd}>
          Add to-do
        </Button>
      </ResponsiveDialogFooter>
    </form>
  );
}

/** The New to-do dialog. */
export function NewTodoDialog({ open, onOpenChange, source }: NewTodoDialogProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{source ? 'Make a to-do' : 'New to-do'}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className={source ? undefined : 'sr-only'}>
            {source
              ? 'From a message. It links back to it.'
              : 'Add something for you or an agent to do.'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {open && <NewTodoForm onDone={() => onOpenChange(false)} {...(source ? { source } : {})} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
