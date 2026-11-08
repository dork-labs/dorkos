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
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { TODO_WHAT_MAX } from '@dorkos/shared/todo-promise-schemas';
import type { CreateTodoRequest, TodoAssignee } from '@dorkos/shared/todo-schemas';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useCreateTodo } from '@/layers/entities/todo';
import { getAgentDisplayName } from '@/layers/shared/lib';
import {
  Button,
  Input,
  Textarea,
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
  const line = (text.split('\n').find((part) => part.trim().length > 0) ?? '').trim();
  const cut = line.slice(0, TODO_WHAT_MAX);
  // Never end on half an emoji: drop a lone high surrogate the cut left behind.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
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

/** Lines the title grows to before it scrolls. */
const TITLE_MAX_LINES = 3;

/**
 * The title: one line that grows to three as the words need, with the caret at the start so a
 * long title made from a message shows its beginning. Enter adds the to-do; a title has no line
 * breaks, so a pasted one becomes spaces.
 */
function TitleField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.setSelectionRange(0, 0);
    field.scrollTop = 0;
  }, []);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const style = getComputedStyle(field);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const line = px(style.lineHeight) || 20;
    const frame =
      px(style.paddingTop) +
      px(style.paddingBottom) +
      px(style.borderTopWidth) +
      px(style.borderBottomWidth);
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight + px(style.borderTopWidth) + px(style.borderBottomWidth), line * TITLE_MAX_LINES + frame)}px`;
  }, [value]);
  return (
    <Textarea
      ref={ref}
      id={id}
      rows={1}
      value={value}
      maxLength={TODO_WHAT_MAX}
      required
      autoFocus
      placeholder="Send the March invoice"
      className="min-h-0 resize-none"
      onChange={(event) => onChange(event.target.value.replace(/\r?\n/g, ' '))}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
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
          <TitleField id={`${ids}-what`} value={what} onChange={setWhat} />
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
      {/* Sized to its three fields: the dialog's default half-screen height left a gap above
          the buttons (DOR-3715). */}
      <ResponsiveDialogContent className="min-h-0 max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{source ? 'Make a to-do' : 'New to-do'}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className={source ? undefined : 'sr-only'}>
            {source ? 'Made from a message.' : 'Add something for you or an agent to do.'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {open && <NewTodoForm onDone={() => onOpenChange(false)} {...(source ? { source } : {})} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
