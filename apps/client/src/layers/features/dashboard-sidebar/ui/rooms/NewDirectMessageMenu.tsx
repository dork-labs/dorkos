import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent, SidebarGroupAction } from '@/layers/shared/ui';
import { AgentChipPicker, type AgentPickerCandidate } from './AgentChipPicker';

interface NewDirectMessageMenuProps {
  /** Every agent on the roster, sorted by name. Nothing is filtered out. */
  candidates: AgentPickerCandidate[];
  /**
   * Open a conversation with these agents, in the order they were picked. One
   * gives a one-to-one; two or more give a group.
   */
  onStart: (chosen: AgentPickerCandidate[]) => void;
}

/**
 * The "+" beside Direct messages: pick one agent for a one-to-one, or several
 * for a group conversation.
 *
 * The picking itself is {@link AgentChipPicker}, shared with the members panel
 * so putting agents in a new conversation and putting them in an existing room
 * are the same gesture. This adds only the popover around it and the copy that
 * makes it about starting a conversation.
 *
 * **Nothing is filtered out of the list.** Every agent stays offerable however
 * many conversations it is already in, because Ana alone and Ana + Kai are
 * different conversations. What used to stop a duplicate — hiding agents that
 * already had a DM — now lives on the server, which matches a direct message on
 * its exact member set and answers with the one you already have.
 *
 * The picker is mounted by the open popover and unmounted with it, so a
 * half-assembled conversation is forgotten rather than waiting there next time.
 */
export function NewDirectMessageMenu({ candidates, onStart }: NewDirectMessageMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarGroupAction aria-label="New direct message">
          <Plus />
        </SidebarGroupAction>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-64 p-2"
        // The picker focuses its own field on mount; Radix must not race it to
        // whatever happens to be the first tabbable element.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <AgentChipPicker
          takeFocus
          candidates={candidates}
          onSubmit={(chosen) => {
            setOpen(false);
            onStart(chosen);
          }}
          submitLabel={(count) => (count > 1 ? 'Start group conversation' : 'Start conversation')}
          emptyRosterMessage="You have not added any agents yet. Add one to start a direct message with it."
          allChosenMessage="Everyone you have added is already in this conversation."
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The candidate shape this menu offers, re-exported under its original name so
 * existing callers keep importing one thing from one place.
 */
export type DirectMessageCandidate = AgentPickerCandidate;
