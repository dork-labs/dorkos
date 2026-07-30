import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  SidebarGroupAction,
} from '@/layers/shared/ui';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { useAgentPickerCandidates } from '../model/use-agent-picker-candidates';
import { AgentRosterPicker } from './AgentRosterPicker';

interface NewDirectMessageMenuProps {
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
 * The picking itself is {@link AgentRosterPicker}, shared with the members panel
 * so putting agents in a new conversation and putting them in an existing room
 * are the same gesture. This adds only the shell around it and the copy that
 * makes it about starting a conversation.
 *
 * **Nothing is filtered out of the list.** Every agent stays offerable however
 * many conversations it is already in, because Ana alone and Ana + Kai are
 * different conversations. What used to stop a duplicate — hiding agents that
 * already had a DM — now lives on the server, which matches a direct message on
 * its exact member set and answers with the one you already have.
 *
 * **A panel on a wide screen, the whole screen on a narrow one**
 * (`ResponsivePopover`, one 768px breakpoint shared by this shell and the `md:`
 * classes inside the picker). Picking who to talk to is a task, not a glance,
 * and the anchored panel was the wrong shape for it on a phone twice over: the
 * sidebar it hangs off _is_ a sheet down there, so it had to close for the panel
 * to be seen, and what was left was a floating box drawn at `x = -17` — off the
 * left edge of the screen. The sheet puts the field at the top where the
 * keyboard cannot reach it, gives the list the height to be a list, and carries
 * a close button, because a phone has no Escape key.
 *
 * `modal` because this is a task: Tab stays inside it, and Escape is the way
 * out. The flex rules that keep it usable while a software keyboard is up live
 * with the markup they apply to, in {@link AgentChipPicker}.
 *
 * The picker is mounted by the open popover and unmounted with it, so a
 * half-assembled conversation is forgotten rather than waiting there next time.
 */
export function NewDirectMessageMenu({ onStart }: NewDirectMessageMenuProps) {
  // Read here rather than taken as a prop: the fleet is this slice's business,
  // and asking for it directly is what keeps the sidebar from having to know
  // about it (see the module doc on `features/room-management`).
  const roster = useAgentPickerCandidates();
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen} modal fullHeight>
      <ResponsivePopoverTrigger asChild>
        <SidebarGroupAction aria-label="New direct message">
          <Plus />
        </SidebarGroupAction>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="right"
        align="start"
        // A column, so the list inside can give height back when the panel is
        // clamped: on a 844x390 window the desktop panel is capped at 70vh and
        // a fixed-height list pushed the commit button below the fold.
        className="flex w-64 flex-col p-2"
        // Names the desktop panel, which is a focus-trapping `role="dialog"`
        // and would otherwise be an unnamed one. On mobile the sheet's own
        // heading wins, per the accname precedence rules, and says the same.
        aria-label="New message"
        // The search field, not whatever happens to be first in the DOM. The
        // popover has to place this itself: focus set from inside the picker is
        // overwritten a commit later by the trigger's own focus restore.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        {/* The sheet's heading, and its accessible name. Null on desktop, where
            the panel is anchored to a "+" that already says what it does. */}
        <ResponsivePopoverTitle>New message</ResponsivePopoverTitle>

        <AgentRosterPicker
          inputRef={searchRef}
          roster={roster}
          onSubmit={(chosen) => {
            setOpen(false);
            onStart(chosen);
          }}
          submitLabel={(count) => (count > 1 ? 'Start group conversation' : 'Start conversation')}
          emptyRosterMessage="You have not added any agents yet. Add one to start a direct message with it."
          allChosenMessage="Everyone you have added is already in this conversation."
        />
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
