import { useRef } from 'react';
import { Plus } from 'lucide-react';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  SidebarGroupAction,
} from '@/layers/shared/ui';
import { useAgentCreationStore } from '@/layers/shared/model';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { useAgentPickerCandidates } from '../model/use-agent-picker-candidates';
import { ONE_DOOR_HINT, oneDoorSubmitLabel } from '../lib/one-door';
import { AgentRosterPicker } from './AgentRosterPicker';

interface NewDirectMessageMenuProps {
  /**
   * Open a conversation with these agents, in the order they were picked.
   *
   * **The caller answers the same rule this panel's button says**
   * ({@link opensAgentSession}): exactly one agent opens that agent's session,
   * two or more make a group message. Both read it from `lib/one-door`, so a
   * button reading "Open session with Ana" can never sit over a handler that
   * makes a room.
   */
  onStart: (chosen: AgentPickerCandidate[]) => void;
  /**
   * Whether the picker is showing. Controlled by the caller, because the "+"
   * this hangs off is no longer the only way in: the section header's
   * "New message…" opens the same panel (spec `rooms` §14.1), and two owners of
   * one panel is two panels waiting to happen.
   */
  open: boolean;
  /** Show or hide the picker. */
  onOpenChange: (open: boolean) => void;
  /**
   * Render no "+" of its own — the panel is opened from a control somewhere
   * else and only needs an anchor.
   *
   * A section that already carries a "+" cannot carry a second one, and the
   * sidebar's Agents header is exactly that case while it hosts this panel's
   * only entry point (see its call site). The trigger still exists in the DOM
   * as the popover's anchor; it is simply not drawn.
   */
  hideTrigger?: boolean;
}

/**
 * The "+" beside Direct messages: pick one agent to open its session, or
 * several to start a group message.
 *
 * **One door to an agent** (`sidebar-simplification` D2). Picking exactly one
 * agent lands in the same conversation its sidebar row opens, because a 1:1
 * direct message was that session in disguise — same agent, same working
 * directory, and a log that showed its final words and none of its work. Two or
 * more make a room, which is the thing a room is actually for. The rule is
 * {@link opensAgentSession}, read here for the button's words and by whatever
 * mounted this for where pressing it lands; the sentence under the picker says
 * it in advance.
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
 *
 * **A fleet with nobody in it is answered with the button, not with an
 * instruction.** "Add one to start a direct message with it" is a next step
 * made out of a person: it names something to go and find and then leaves. The
 * room sheet stopped doing that; this is the same panel, offering the same way
 * out of the same sentence.
 */
export function NewDirectMessageMenu({
  onStart,
  open,
  onOpenChange,
  hideTrigger = false,
}: NewDirectMessageMenuProps) {
  // Read here rather than taken as a prop: the fleet is this slice's business,
  // and asking for it directly is what keeps the sidebar from having to know
  // about it (see the module doc on `features/room-management`).
  const roster = useAgentPickerCandidates();
  const searchRef = useRef<HTMLInputElement>(null);

  /**
   * Leave for the place agents are made.
   *
   * This panel closes first, and that is the decision rather than an omission:
   * it is a modal popover, so it holds the focus scope, and raising a dialog
   * inside one leaves two things claiming the keyboard. There is nothing here
   * worth keeping either — this button only exists on a fleet with nobody in
   * it, so there is no half-assembled conversation to lose.
   */
  const startAgentCreation = () => {
    onOpenChange(false);
    useAgentCreationStore.getState().open();
  };

  return (
    <ResponsivePopover open={open} onOpenChange={onOpenChange} modal fullHeight>
      <ResponsivePopoverTrigger asChild>
        {/* "New message", not "New direct message": the section header's own
            item beside it opens this very panel and is named that, and the
            panel it opens is titled that too. One action, one name. */}
        <SidebarGroupAction
          // Named for the people who press it — and named for nobody when it is
          // only an anchor. `sr-only` hides a control from SIGHT and leaves it
          // announced and focusable, which is a phantom "New message" offered to
          // exactly the readers who cannot see that it is a phantom.
          // `aria-hidden` + `tabIndex={-1}` take it out of the accessibility
          // tree and the tab order at the source, rather than leaning on the
          // sidebar's roving-focus hook to stamp it: this component does not
          // know whether it is inside one.
          {...(hideTrigger
            ? { 'aria-hidden': true, tabIndex: -1, className: 'sr-only' }
            : { 'aria-label': 'New message' })}
        >
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
            onOpenChange(false);
            onStart(chosen);
          }}
          submitLabel={oneDoorSubmitLabel}
          emptyRosterMessage="You have not added any agents yet."
          emptyRosterAction={
            <Button type="button" size="sm" variant="outline" onClick={startAgentCreation}>
              Create agent
            </Button>
          }
          allChosenMessage="Everyone you have added is already in this conversation."
        />

        {/* The rule, said before the button changes its words rather than
            after. */}
        <p className="text-muted-foreground mt-2 shrink-0 px-2 text-xs">{ONE_DOOR_HINT}</p>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
