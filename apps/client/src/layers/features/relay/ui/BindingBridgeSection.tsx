import { appRoutes } from '@/layers/shared/lib';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { Ban, Hash } from 'lucide-react';
import {
  Button,
  Spinner,
  Switch,
  Label,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  MoreDetails,
} from '@/layers/shared/ui';
import { useUpdateBinding } from '@/layers/entities/binding';
import { useRoom, useSetDeliverNotices } from '@/layers/entities/room';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

/**
 * The plain statements shown at the moment of bridging (chats-as-channels spec
 * §9.4). Said once, here, so a person turns a chat into a channel knowing
 * exactly what changes. The spec's three statements, in plain words, one short
 * line each (the app-copy cap is 15 words a block); the permissions statement
 * takes two lines, so its trust caveat is not cut.
 */
const BRIDGE_WARNINGS = [
  'People you may not know can put text in front of your agent.',
  'Permissions are the real limit. A bridged chat asks before acting by default.',
  'Raise that only if you trust everyone in the chat.',
  'The channel keeps the whole record: every message that reached your agent, for good.',
] as const;

export interface BindingBridgeSectionProps {
  /** The binding whose bridge this section turns on and off. */
  binding: AdapterBinding;
  /** Called after a bridge or un-bridge lands, so the dialog can close. */
  onDone?: () => void;
}

/**
 * The "Bridge to a channel" controls for one binding, in the Connections detail
 * sheet (chats-as-channels spec §3.1). Lives in the feature layer because
 * turning a bridge on lands the person in the new channel and its settings read
 * the room — both cross-entity concerns the entity dialog cannot hold.
 *
 * Renders one of four states: a chat that cannot be bridged says why (never a
 * dead button); a bridgeable chat offers the action under the §9.4 warning; a
 * bridged chat shows what reaches the far end and an un-bridge that confirms
 * first.
 */
export function BindingBridgeSection({ binding, onDone }: BindingBridgeSectionProps) {
  const updateBinding = useUpdateBinding({ errorLabel: 'Couldn’t bridge that chat' });
  const navigate = useNavigate();

  if (binding.bridge === 'room') {
    return <BridgedControls binding={binding} onDone={onDone} />;
  }

  // A chat-wildcard binding names no single chat, so there is no one chat to
  // become a channel. Shown as the reason, not a disabled control (§3.1).
  if (!binding.chatId) {
    return <BridgeRefusal reason="This reaches every chat here. Point it at one chat first." />;
  }

  // What this chat can become is decided by its raw platform type (DOR-907),
  // mirroring the server's own rule. A broadcast never bridges: it is a one-way
  // feed, not a conversation (spec §3.3). A group or supergroup now can. A chat
  // whose type we never recorded (a binding made before DOR-907, or outside the
  // claim flow) bridges only when it is a one-to-one, since a DM is the one
  // shape provably not a broadcast. The server refuses the same cases; this
  // states the reason instead of a dead button.
  if (binding.platformChatType === 'channel') {
    return (
      <BridgeRefusal reason="This is a broadcast channel, not a two-way conversation. Your agent can’t reply." />
    );
  }
  const isDirectMessage = binding.channelType == null || binding.channelType === 'dm';
  const bridgeable =
    binding.platformChatType === 'private' ||
    binding.platformChatType === 'group' ||
    binding.platformChatType === 'supergroup' ||
    (binding.platformChatType == null && isDirectMessage);
  if (!bridgeable) {
    return (
      <BridgeRefusal reason="DorkOS doesn’t know what kind of chat this is. Reconnect it from a new message." />
    );
  }

  async function handleBridge() {
    try {
      const updated = await updateBinding.mutateAsync({
        id: binding.id,
        updates: { bridge: 'room' },
      });
      if (updated.roomId) {
        void navigate({ ...appRoutes.channels(), search: { id: updated.roomId } });
      }
      onDone?.();
    } catch {
      // Reported by the shared mutation toast (`useUpdateBinding`'s
      // `meta.errorLabel`, set above).
    }
  }

  return (
    <section
      className="border-border/60 space-y-3 rounded-lg border p-3"
      aria-labelledby="bridge-heading"
    >
      <div className="flex items-center gap-2">
        <Hash className="text-muted-foreground size-4" />
        <h4 id="bridge-heading" className="text-sm font-medium">
          Bridge to a channel
        </h4>
      </div>
      <p className="text-muted-foreground text-xs">
        Messages land in a channel your agent reads. You can reply from there too.
      </p>
      <ul className="text-muted-foreground space-y-1.5 text-xs">
        {BRIDGE_WARNINGS.map((line) => (
          <li key={line} className="flex gap-1.5">
            <span aria-hidden className="text-muted-foreground/60">
              •
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <Button size="sm" onClick={handleBridge} disabled={updateBinding.isPending}>
        {updateBinding.isPending && <Spinner size="xs" className="mr-1.5" />}
        Bridge to a channel
      </Button>
    </section>
  );
}

/**
 * The bridged state: choose whether the far end hears about a stalled turn, and
 * un-bridge (with its consequences stated before you confirm).
 */
function BridgedControls({ binding, onDone }: BindingBridgeSectionProps) {
  const updateBinding = useUpdateBinding({ errorLabel: 'Couldn’t un-bridge that chat' });
  const setDeliverNotices = useSetDeliverNotices();
  const { data: room } = useRoom(binding.roomId ?? null);
  // Until the room resolves we do not know the seeded value (a DM seeds true, a
  // channel false), so the toggle stays disabled rather than flashing `off`
  // and then flipping — an honest "not ready yet" over a wrong answer.
  const roomLoaded = room !== undefined;
  const deliverNotices = room?.deliverNotices ?? false;

  async function handleUnbridge() {
    try {
      await updateBinding.mutateAsync({ id: binding.id, updates: { bridge: 'off' } });
      toast.success('This chat is private again');
      onDone?.();
    } catch {
      // Reported by the shared mutation toast (`useUpdateBinding`'s
      // `meta.errorLabel`, set above).
    }
  }

  return (
    <section className="border-border/60 space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Hash className="text-muted-foreground size-4" />
        <p className="text-sm font-medium">This chat is a channel</p>
      </div>

      {binding.roomId && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="bridge-deliver-notices" className="cursor-pointer text-xs font-normal">
              Tell this chat when your agent stops early
            </Label>
            <Switch
              id="bridge-deliver-notices"
              checked={deliverNotices}
              disabled={!roomLoaded || setDeliverNotices.isPending}
              onCheckedChange={(v) =>
                setDeliverNotices.mutate({ roomId: binding.roomId!, deliverNotices: v })
              }
              aria-label="Tell this chat when your agent stops early"
            />
          </div>
          <p className="text-muted-foreground text-xs">People in this chat see a short note.</p>
        </div>
      )}

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            Un-bridge this chat
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Un-bridge this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              Its channel is archived. The chat goes back to a private, one-to-one line.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <MoreDetails>
            <p>The channel and everything in it are kept.</p>
            <p>Bridging this chat again brings its history back.</p>
            <p>For a clean start with no old messages, archive the channel, then bridge again.</p>
          </MoreDetails>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it bridged</AlertDialogCancel>
            <AlertDialogAction onClick={handleUnbridge}>Un-bridge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** State for a chat that cannot be bridged: the reason, never a dead button. */
function BridgeRefusal({ reason }: { reason: string }) {
  return (
    <section className="border-border/60 bg-muted/30 flex gap-2 rounded-lg border p-3">
      <Ban className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Can’t bridge this chat</p>
        <p className="text-muted-foreground text-xs">{reason}</p>
      </div>
    </section>
  );
}
