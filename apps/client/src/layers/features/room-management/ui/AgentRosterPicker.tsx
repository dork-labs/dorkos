import type { ReactNode, RefObject } from 'react';
import { Button, Skeleton } from '@/layers/shared/ui';
import type { AgentPickerCandidate, AgentRoster } from '@/layers/entities/agent';
import { AgentChipPicker } from './AgentChipPicker';

interface AgentRosterPickerProps {
  /** The fleet, and whether it is known. */
  roster: AgentRoster;
  /** Agents to leave out — whoever is already in the room. */
  exclude?: (candidate: AgentPickerCandidate) => boolean;
  /** Commit the selection, in the order the agents were picked. */
  onSubmit: (chosen: AgentPickerCandidate[]) => void;
  /** The commit button's label, given what is selected. */
  submitLabel: (chosen: readonly AgentPickerCandidate[]) => string;
  /** Shown instead of the field when the fleet is genuinely empty. */
  emptyRosterMessage: string;
  /** A way out of {@link AgentRosterPickerProps.emptyRosterMessage}, when there is one. */
  emptyRosterAction?: ReactNode;
  /** Shown under the field when every candidate is already a chip. */
  allChosenMessage: string;
  /** Disable the commit button while a write is in flight. */
  isSubmitting?: boolean;
  /** The container's own reason the selection cannot be committed yet. */
  submitDisabled?: boolean;
  /** The search field, handed back so the container can place the cursor. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * {@link AgentChipPicker}, with the two states a bare list of candidates cannot
 * express.
 *
 * The picker itself is deliberately incurious: hand it no candidates and it
 * says whatever it was told to say. That is right for a component whose job is
 * picking, and wrong for the only thing standing between a reader and a claim
 * about their own account — "You have not added any agents yet" rendered to
 * somebody with three agents, beside a roster drawing their faces, with nothing
 * to press. So the answer's *provenance* is handled here, once, rather than in
 * each of the three surfaces that shows a picker:
 *
 * - **Loading** draws the field's shape. Not a spinner, and not the empty copy:
 *   the reader is a moment from a list, and telling them they have nobody in
 *   the meantime is a sentence they have to un-believe.
 * - **Failed** says so and offers to ask again. An error state that asserts
 *   something false about the person's own account is worse than no state at
 *   all, and one with no way forward is worse still.
 * - **Empty** is the only case that reaches `emptyRosterMessage`, which is now
 *   the honest sentence it always claimed to be.
 */
export function AgentRosterPicker({ roster, exclude, ...picker }: AgentRosterPickerProps) {
  if (roster.isError) {
    return (
      <div role="alert" className="space-y-2 py-1">
        <p className="text-muted-foreground text-xs">
          Couldn&apos;t read your agents just now, so there is nothing to choose from. They are all
          still there.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={roster.retry}>
          Try again
        </Button>
      </div>
    );
  }

  if (roster.isLoading) {
    return (
      <div aria-busy className="space-y-2 py-1">
        {/* Reserves the field and the button, so nothing jumps when the real
            list lands under a cursor already on its way to it. */}
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <span className="sr-only">Reading your agents…</span>
      </div>
    );
  }

  return (
    <AgentChipPicker
      candidates={exclude ? roster.candidates.filter((c) => !exclude(c)) : roster.candidates}
      {...picker}
    />
  );
}
