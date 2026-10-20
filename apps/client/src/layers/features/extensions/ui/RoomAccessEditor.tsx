/**
 * "Rooms it can use" for one mini app that asks for rooms
 * (`capabilities.rooms`, DOR-3017), on its card in Settings → Extensions.
 *
 * The mini app reads and replies as the person, only in the rooms listed here.
 * Each is a removable chip, with an Add picker of the person's channels and
 * direct messages on this computer. With none listed it reaches nothing.
 *
 * @module features/extensions/ui/RoomAccessEditor
 */
import { useMemo, useState } from 'react';
import { Hash, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { roomDisplayTitle, useRooms } from '@/layers/entities/room';
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/layers/shared/ui';
import { useRoomAccess, useSetRoomAccess } from '../api/room-access';

/**
 * The editor for one mini app's rooms.
 *
 * @param props.extensionId - The mini app.
 * @param props.name - Its name, for labels.
 */
export function RoomAccessEditor({ extensionId, name }: { extensionId: string; name: string }) {
  const allowed = useRoomAccess(extensionId).data ?? [];
  const { mutate } = useSetRoomAccess(extensionId);
  const rooms = useRooms().data;
  // Only rooms on this computer: a bridged room delivers to another app, so a
  // mini app can never post there.
  const choices = useMemo(() => (rooms ?? []).filter((room) => !room.bridge), [rooms]);
  const titles = useMemo(
    () => new Map((rooms ?? []).map((room) => [room.id, roomDisplayTitle(room)])),
    [rooms]
  );

  const save = (next: string[]) => mutate(next, { onError: (err) => toast.error(err.message) });
  const titleOf = (id: string) => titles.get(id) ?? 'A room that is gone';

  return (
    <div className="space-y-1.5 pt-1" data-testid={`room-access-${extensionId}`}>
      <p className="text-sm">Rooms it can use</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {allowed.map((id) => (
          <span
            key={id}
            className="bg-muted inline-flex h-6 items-center gap-1 rounded-md pr-0.5 pl-1.5 text-xs"
          >
            <Hash className="text-muted-foreground size-3" aria-hidden />
            <span className="max-w-40 truncate">{titleOf(id)}</span>
            <button
              type="button"
              onClick={() => save(allowed.filter((roomId) => roomId !== id))}
              aria-label={`Remove ${titleOf(id)}`}
              className="text-muted-foreground hover:text-foreground focus-ring rounded-sm p-0.5"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <AddRoom
          name={name}
          rooms={choices.filter((room) => !allowed.includes(room.id))}
          onAdd={(id) => save([...allowed, id])}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        {allowed.length === 0
          ? 'None yet. It can’t read or reply anywhere.'
          : 'It reads and replies as you, only here.'}
      </p>
    </div>
  );
}

/** The Add picker: the person's rooms not already listed, searchable. */
function AddRoom({
  name,
  rooms,
  onAdd,
}: {
  name: string;
  rooms: readonly RoomSummary[];
  onAdd: (roomId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          aria-label={`Add a room for ${name}`}
        >
          <Plus className="size-3" />
          Add
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Find a channel or DM" />
          <CommandList className="max-h-64">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {rooms.length > 0 && (
              <CommandGroup heading="Channels and DMs">
                {rooms.map((room) => (
                  <CommandItem
                    key={room.id}
                    value={`room ${roomDisplayTitle(room)} ${room.id}`}
                    onSelect={() => {
                      onAdd(room.id);
                      setOpen(false);
                    }}
                  >
                    <Hash className="size-3.5" />
                    {roomDisplayTitle(room)}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
