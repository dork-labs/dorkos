/**
 * Work queue — the agent's ordered list of work (DOR-3462). Off until a person
 * turns it on; then, when one of its queued chats ends under the target, the next
 * item starts on its own. A person sees the list, orders it, adds to it, turns it
 * off, sets its limits, and can stop every queue at once. Only drawn on your own
 * agents and DorkBot: the prompts are yours, and the routes refuse anyone else.
 *
 * @module features/profile/ui/pages/WorkQueuePage
 */
import { useId, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import {
  WORK_ITEM_PROMPT_MAX,
  WORK_ITEM_TITLE_MAX,
  WORK_QUEUE_DAILY_CAP_MAX,
  WORK_QUEUE_TARGET_MAX,
  type UpdateWorkQueueRequest,
  type WorkItem,
  type WorkItemOutcome,
  type WorkQueueHold,
} from '@dorkos/shared/work-queue-schemas';
import {
  useAddWorkItem,
  useRemoveWorkItem,
  useReorderWorkQueue,
  useRequeueWorkItem,
  useSetWorkQueuesStopped,
  useUpdateWorkQueue,
  useWorkQueue,
} from '@/layers/entities/work-queue';
import { Button, Input, Switch, Textarea } from '@/layers/shared/ui';
import type { ProfilePageContentProps } from './types';

/** Why the next item is not starting. */
const HOLD_WORDS: Record<WorkQueueHold, string> = {
  stopped: 'Waiting: every queue is stopped.',
  'daily-cap': 'Waiting: this queue reached its limit for today.',
  disk: 'Waiting: under 20 GB of disk free.',
  load: 'Waiting: this computer is too busy.',
  accounts: 'Waiting: every account is near its limit.',
  'chat-cap': 'Waiting: too many chats are running.',
  permission: 'Waiting: this agent must ask before starting chats.',
  'agent-paused': 'Waiting: this agent is paused.',
  'agent-missing': 'Waiting: this agent is not registered.',
};

/** How an item ended. */
const OUTCOME_WORDS: Record<WorkItemOutcome, string> = {
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  limit: 'Hit an account limit',
  interrupted: 'Interrupted by a restart',
};

/** One waiting item, with its order and remove controls. */
function WaitingRow(props: {
  item: WorkItem;
  onUp?: () => void;
  onDown?: () => void;
  onRemove: () => void;
}) {
  const { item, onUp, onDown, onRemove } = props;
  return (
    <li className="flex items-center gap-1 rounded-md border px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Move up: ${item.title}`}
        disabled={!onUp}
        onClick={onUp}
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Move down: ${item.title}`}
        disabled={!onDown}
        onClick={onDown}
      >
        <ArrowDown className="size-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove: ${item.title}`}
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>
    </li>
  );
}

/** A labelled whole-number setting, saved when focus leaves it. */
function NumberRow(props: {
  label: string;
  value: number;
  max: number;
  onSave: (next: number) => void;
}) {
  const { label, value, max, onSave } = props;
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        className="w-20"
        min={1}
        max={max}
        key={value}
        defaultValue={value}
        onBlur={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= 1 && next <= max && next !== value) onSave(next);
        }}
      />
    </div>
  );
}

/** A labelled switch. */
function SwitchRow(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { label, checked, onChange } = props;
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** The inline form that adds one item. */
function AddItemForm({ agentId }: { agentId: string }) {
  const add = useAddWorkItem(agentId);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const titleId = useId();
  const promptId = useId();
  const ready = title.trim() !== '' && prompt.trim() !== '';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    add.mutate(
      { title: title.trim(), prompt: prompt.trim() },
      {
        onSuccess: () => {
          setTitle('');
          setPrompt('');
        },
      }
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border p-3">
      <label htmlFor={titleId} className="text-xs font-medium">
        Title
      </label>
      <Input
        id={titleId}
        value={title}
        maxLength={WORK_ITEM_TITLE_MAX}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor={promptId} className="text-xs font-medium">
        First message
      </label>
      <Textarea
        id={promptId}
        value={prompt}
        rows={3}
        maxLength={WORK_ITEM_PROMPT_MAX}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {add.isError && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t add it. Try again.
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!ready || add.isPending}>
          Add to queue
        </Button>
      </div>
    </form>
  );
}

/** This agent's work queue. */
export function WorkQueuePage({ member }: ProfilePageContentProps) {
  const agentId = member.agent?.manifestId;
  return agentId ? <WorkQueueBody agentId={agentId} /> : null;
}

function WorkQueueBody({ agentId }: { agentId: string }) {
  const queue = useWorkQueue(agentId);
  const update = useUpdateWorkQueue(agentId);
  const stopAll = useSetWorkQueuesStopped();
  const reorder = useReorderWorkQueue(agentId);
  const remove = useRemoveWorkItem(agentId);
  const requeue = useRequeueWorkItem(agentId);

  if (!queue.data) return null;
  const { enabled, target, dailyStartCap, startsToday, allStopped, hold, items, recent } =
    queue.data;
  const waiting = items.filter((item) => item.state === 'queued');
  const running = items.filter((item) => item.state !== 'queued');
  const change = (body: UpdateWorkQueueRequest) => update.mutate(body);

  /** Swap one waiting item with its neighbour. */
  const move = (index: number, by: -1 | 1) => {
    const ids = waiting.map((item) => item.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + by, 0, moved);
    reorder.mutate(ids);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      data-slot="profile-work-queue"
    >
      <div className="flex flex-col gap-3">
        <SwitchRow
          label="Start the next item on its own"
          checked={enabled}
          onChange={(on) => change({ enabled: on })}
        />
        <NumberRow
          label="Chats at once"
          value={target}
          max={WORK_QUEUE_TARGET_MAX}
          onSave={(next) => change({ target: next })}
        />
        <NumberRow
          label={`Starts per day (${startsToday} today)`}
          value={dailyStartCap}
          max={WORK_QUEUE_DAILY_CAP_MAX}
          onSave={(next) => change({ dailyStartCap: next })}
        />
        <SwitchRow
          label="Stop every agent's queue"
          checked={allStopped}
          onChange={(on) => stopAll.mutate(on)}
        />
        {enabled && hold && <p className="text-muted-foreground text-xs">{HOLD_WORDS[hold]}</p>}
      </div>

      {running.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">Running</h3>
          <ul className="flex flex-col gap-1">
            {running.map((item) => (
              <li key={item.id} className="truncate rounded-md border px-3 py-2 text-sm">
                {item.title}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium">Up next</h3>
        {waiting.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing is waiting.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {waiting.map((item, index) => (
              <WaitingRow
                key={item.id}
                item={item}
                {...(index > 0 ? { onUp: () => move(index, -1) } : {})}
                {...(index < waiting.length - 1 ? { onDown: () => move(index, 1) } : {})}
                onRemove={() => remove.mutate(item.id)}
              />
            ))}
          </ol>
        )}
      </section>

      <AddItemForm agentId={agentId} />

      {recent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">Recent</h3>
          <ul className="flex flex-col gap-1">
            {recent.map((item) => (
              <li key={item.id} className="flex items-center gap-2 px-3 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="text-muted-foreground text-xs">
                  {item.outcome ? OUTCOME_WORDS[item.outcome] : null}
                </span>
                <Button size="sm" variant="ghost" onClick={() => requeue.mutate(item.id)}>
                  Queue again
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
