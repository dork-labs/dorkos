/**
 * Record a promise an agent made, as the person: what, and optionally when.
 *
 * @module features/commitments/ui/AddCommitmentForm
 */
import { useId, useState, type FormEvent } from 'react';
import { COMMITMENT_WHAT_MAX } from '@dorkos/shared/commitment-schemas';
import { useCreateCommitment } from '@/layers/entities/commitment';
import { Button, Input } from '@/layers/shared/ui';

/** How far in the past a due date may be, matching the server's clock-skew allowance. */
const DUE_SKEW_MS = 60_000;

/** A `datetime-local` value for this moment, in the person's own clock. */
function localNow(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Props for {@link AddCommitmentForm}. */
export interface AddCommitmentFormProps {
  /** The agent the promise belongs to. */
  agentId: string;
  /** Called after it saved, or on Cancel. */
  onDone: () => void;
}

/** The inline form under a commitments list. */
export function AddCommitmentForm({ agentId, onDone }: AddCommitmentFormProps) {
  const create = useCreateCommitment();
  const [what, setWhat] = useState('');
  const [due, setDue] = useState('');
  const whatId = useId();
  const dueId = useId();
  const trimmed = what.trim();
  // The server judges the date again, by its own clock (`PAST_DUE`).
  const serverSaysPast =
    create.isError && (create.error as { code?: string } | null)?.code === 'PAST_DUE';
  // `datetime-local` is the person's own clock; a Date reads it as local time.
  const dueMs = due ? new Date(due).getTime() : null;
  // Judged when the time is picked, not on every render: a clock read during
  // render is impure, and the server refuses a past date anyway.
  const [dueHasPassed, setDueHasPassed] = useState(false);
  const [earliest] = useState(localNow);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || dueHasPassed) return;
    const dueAt = dueMs !== null ? new Date(dueMs).toISOString() : undefined;
    create.mutate(
      { agentId, body: { what: trimmed, ...(dueAt ? { dueAt } : {}) } },
      { onSuccess: onDone }
    );
  }

  return (
    <form
      onSubmit={submit}
      data-slot="add-commitment-form"
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <label htmlFor={whatId} className="text-xs font-medium">
        What was promised
      </label>
      <Input
        id={whatId}
        value={what}
        maxLength={COMMITMENT_WHAT_MAX}
        onChange={(event) => setWhat(event.target.value)}
        placeholder="Send Acme the revised quote"
      />
      <label htmlFor={dueId} className="text-xs font-medium">
        Due (optional)
      </label>
      <Input
        id={dueId}
        type="datetime-local"
        value={due}
        min={earliest}
        aria-invalid={dueHasPassed || undefined}
        onChange={(event) => {
          const value = event.target.value;
          setDue(value);
          setDueHasPassed(value !== '' && new Date(value).getTime() < Date.now() - DUE_SKEW_MS);
        }}
      />
      {(dueHasPassed || serverSaysPast) && (
        <p className="text-destructive text-xs">That time has passed.</p>
      )}
      {create.isError && !serverSaysPast && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t save the commitment. Try again.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!trimmed || dueHasPassed || create.isPending}>
          Add commitment
        </Button>
      </div>
    </form>
  );
}
