import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import {
  Button,
  Input,
  Label,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { isChannelNameConflict, useCreateChannel } from '@/layers/entities/room';
import { useAgentPickerCandidates } from '../model/use-agent-picker-candidates';
import { AgentRosterPicker } from './AgentRosterPicker';

/** Longest channel name the server accepts (`CreateRoomRequestSchema.title`). */
const MAX_NAME = 200;

interface ChannelCreateDialogProps {
  /** Whether the dialog is on screen. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channel that was made, so the caller can open it. */
  onCreated: (room: RoomWithRoster) => void;
}

/**
 * Make a channel, with the agents that are to be in it.
 *
 * **A channel with nobody in it does nothing** — you can post in it forever and
 * nothing answers. So naming it and filling it are one step, not two (spec
 * `rooms` §14.2). The picker is the same one the direct-message flow and the
 * members panel use, so the three read as one product rather than three
 * features.
 *
 * A modal rather than the inline sidebar row this replaced, for the reason spec
 * §14.5 gives: a picker does not fit in a sidebar's width, and a popover
 * anchored to the sidebar is invisible on a phone, where the sidebar is a
 * drawer that has to close for the popover to show. The responsive modal is a
 * dialog on a desktop and a drawer on a phone, and works in both.
 *
 * **Creating with nobody selected stays possible, and stays deliberate.** It is
 * a quiet second button rather than the primary one, and rather than what Enter
 * does — Enter in the name field moves to the agent search, so the fast path
 * through the keyboard is the one that puts somebody in the room. A person who
 * genuinely wants an empty channel is one click from it and has been told what
 * they are getting.
 *
 * **One call, so a half-made channel is not a state that exists.** The server
 * resolves every agent before it writes anything and then writes the room and
 * its roster in one transaction, so a channel either exists with its agents in
 * it or does not exist at all. A failure leaves the dialog open with the name
 * and the chips still in it, because the retry is the same request.
 *
 * **A name conflict renders inline, at the field it is about.** The dialog is
 * still open and still showing the name that collided, so that is where the
 * answer belongs — a toast for a validation error the reader can fix in the
 * next second is theater. Every other failure (a dropped connection, a 500)
 * still toasts, via `useCreateChannel`'s own fallback.
 */
export function ChannelCreateDialog({ open, onOpenChange, onCreated }: ChannelCreateDialogProps) {
  // The fleet is read here rather than handed down, so the sidebar that mounts
  // this never has to hold it — see the module doc on `features/room-management`.
  const agents = useAgentPickerCandidates();
  const [name, setName] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // `useCreateChannel`'s own onError can still run after this dialog unmounts
  // — the parent mounts it only `channelDialogOpen && <ChannelCreateDialog />`,
  // and TanStack keeps a `useMutation`-level callback alive past its observer
  // — so "can a conflict still be shown inline" is read from a live ref, not a
  // value closed over at render time.
  const mountedRef = useRef(true);
  useEffect(() => {
    // The setup half matters as much as the cleanup: StrictMode's dev-only
    // setup→cleanup→setup double-invoke runs the cleanup below once before
    // this ever mounts for real, and with no setup body to restore it the
    // ref was stuck `false` for the dialog's whole life — every conflict
    // read as "not mounted" and toasted on top of the inline alert.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const createChannel = useCreateChannel({ isInlineErrorVisible: () => mountedRef.current });
  const nameConflict = isChannelNameConflict(createChannel.error)
    ? createChannel.error.message
    : null;

  const trimmed = name.trim();
  const nameIsValid = trimmed.length > 0 && trimmed.length <= MAX_NAME;

  const create = (chosen: AgentPickerCandidate[]) => {
    if (!nameIsValid || createChannel.isPending) return;
    createChannel.mutate(
      { title: trimmed, agentPaths: chosen.map((agent) => agent.agentPath) },
      {
        onSuccess: (room) => {
          onOpenChange(false);
          onCreated(room);
        },
        // No local onError here either: `useCreateChannel` reports every
        // failure itself now (inline for a name conflict, a toast for
        // everything else) — see its own TSDoc. The dialog stays open on its
        // own regardless, since `onOpenChange(false)` above only ever runs on
        // success, so the name and the chips are still on screen for the retry.
      }
    );
  };

  /**
   * Enter in the name field goes to the agent search, not to Create.
   *
   * This is the whole point of the dialog expressed as one key: the default
   * path names a channel AND fills it. Submitting here would make the empty
   * channel the fastest thing to make, which is the behaviour this replaced.
   */
  const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (nameIsValid) searchRef.current?.focus();
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="sm:max-w-md"
        // The name is what the reader came to type, and it is not the first
        // tabbable thing in the content — the dialog's own close button is. So
        // the focus is placed rather than left to Radix's default.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameRef.current?.focus();
        }}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>New channel</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Name it, and pick the agents you want in it. A channel with nobody in it has nobody to
            answer you.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="channel-name">Channel name</Label>
            <Input
              ref={nameRef}
              id="channel-name"
              value={name}
              maxLength={MAX_NAME}
              placeholder="Backend"
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                // Editing the name is what fixes the conflict, so the stale
                // refusal about the OLD name should not still be sitting here.
                if (createChannel.error) createChannel.reset();
              }}
              onKeyDown={handleNameKeyDown}
              aria-invalid={nameConflict ? true : undefined}
              aria-describedby={nameConflict ? 'channel-name-error' : undefined}
            />
            {nameConflict && (
              <p id="channel-name-error" role="alert" className="text-destructive text-xs">
                {nameConflict}
              </p>
            )}
          </div>

          <section aria-label="Agents in this channel" className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">Who&apos;s in it</h3>
            <p className="text-muted-foreground text-xs">
              They join when the channel is made and can read everything said in it. In a channel an
              agent replies when you @mention it, until you say otherwise.
            </p>
            <AgentRosterPicker
              roster={agents}
              onSubmit={create}
              // Three cases, and the zero one is not decoration: this button
              // renders before anything is picked, so a label that claims "1
              // agent" states something false about the selection every time
              // the dialog opens. It is disabled there — the picker above is
              // what to do next, and the quiet button below is the way out
              // without anybody.
              submitLabel={(count) =>
                count === 0
                  ? 'Create channel'
                  : count === 1
                    ? 'Create channel with 1 agent'
                    : `Create channel with ${count} agents`
              }
              // No "Create agent" button beside this one, unlike the room sheet
              // and the direct-message panel. Two reasons, and neither is
              // inertia. Making an agent means a modal over this modal, and
              // answering the inner one reaches the outer as an interaction
              // from outside it — so both would close, taking the name already
              // typed with them. And this sentence is not the dead end that one
              // is: it names the next step, and the button that does it is on
              // screen underneath. An empty fleet is not a reason you cannot
              // make a channel.
              emptyRosterMessage="You have not added any agents yet. You can still make the channel and put agents in it later."
              allChosenMessage="That is every agent you have."
              isSubmitting={createChannel.isPending}
              submitDisabled={!nameIsValid}
              inputRef={searchRef}
            />
          </section>

          {/* Possible, and deliberate: quieter than the primary button, below
              it, and it says what it makes rather than just "Create". */}
          <div className="flex justify-center border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!nameIsValid || createChannel.isPending}
              onClick={() => create([])}
            >
              Create it without agents
            </Button>
          </div>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
