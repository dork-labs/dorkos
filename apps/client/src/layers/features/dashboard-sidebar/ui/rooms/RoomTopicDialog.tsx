import { useState, type FormEvent } from 'react';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Textarea,
} from '@/layers/shared/ui';
import { roomDisplayTitle, useSetRoomTopic } from '@/layers/entities/room';

/** Longest topic the server accepts (`UpdateRoomRequestSchema.topic`). */
const MAX_TOPIC = 500;

interface RoomTopicDialogProps {
  /** The channel whose topic is being edited. */
  room: RoomSummary;
  /** Whether the editor is on screen. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Say what a channel is about.
 *
 * A modal rather than the inline editor a rename uses, for one reason: a topic
 * is a sentence with 500 characters to play with, and a sidebar row is about
 * two hundred pixels wide. Rename stays inline because a name fits there.
 *
 * Clearing the field removes the topic — the field is nullable, and "" would be
 * an empty topic the header would then render as a blank line.
 */
export function RoomTopicDialog({ room, open, onOpenChange }: RoomTopicDialogProps) {
  const [value, setValue] = useState(room.topic ?? '');
  const setTopic = useSetRoomTopic();
  const title = roomDisplayTitle(room);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    // Failures are the shared mutation toast's to report: the hook names the
    // action and the server's own sentence says why.
    setTopic.mutate(
      { roomId: room.id, topic: trimmed === '' ? null : trimmed },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Topic for {title}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              One line about what this channel is for. Everyone in it sees it.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody>
            {/* No `autoFocus`: this field is the first tabbable thing in the
                dialog, so Radix's own open-focus lands on it — and a focus that
                comes from the dialog opening is the dialog's to give. */}
            <Textarea
              value={value}
              maxLength={MAX_TOPIC}
              rows={3}
              aria-label="Channel topic"
              placeholder="What is this channel for?"
              onChange={(event) => setValue(event.target.value)}
            />
            <p className="text-muted-foreground mt-1 text-xs">
              Leave it empty to remove the topic.
            </p>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={setTopic.isPending}>
              {setTopic.isPending ? 'Saving…' : 'Save topic'}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
